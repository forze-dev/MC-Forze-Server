import { pool } from '../services/db.service.js';
import fs from 'fs';
import path from 'path';

// Валідація типів продуктів
const PRODUCT_TYPES = ['item', 'subscription', 'whitelist', 'rank', 'service', 'command'];
const VALID_CATEGORIES = ['blocks', 'tools', 'weapons', 'armor', 'food', 'potions', 'misc', 'ranks', 'services'];

/**
 * Валідація даних продукту залежно від типу
 */
function validateProductData(productType, data) {
	const errors = [];

	switch (productType) {
		case 'item':
			if (!data.item_id) errors.push('item_id є обов\'язковим для товарів типу "item"');
			if (!data.items_data) {
				// Створюємо базову структуру для предмета
				data.items_data = JSON.stringify([{
					minecraft_id: data.item_id,
					amount: data.quantity || 1,
					display_name: data.name
				}]);
			}
			break;

		case 'subscription':
			if (!data.subscription_duration || data.subscription_duration <= 0) {
				errors.push('subscription_duration є обов\'язковим для підписок');
			}
			break;

		case 'command':
			if (!data.execution_config) {
				errors.push('execution_config є обов\'язковим для команд');
			} else {
				try {
					const config = typeof data.execution_config === 'string'
						? JSON.parse(data.execution_config)
						: data.execution_config;

					if (!config.rcon_commands || !Array.isArray(config.rcon_commands)) {
						errors.push('execution_config повинен містити масив rcon_commands');
					}
				} catch (e) {
					errors.push('execution_config має некоректний JSON формат');
				}
			}
			break;

		case 'rank':
		case 'whitelist':
		case 'service':
			// Для цих типів теж може бути execution_config
			if (data.execution_config) {
				try {
					JSON.parse(typeof data.execution_config === 'string' ? data.execution_config : JSON.stringify(data.execution_config));
				} catch (e) {
					errors.push('execution_config має некоректний JSON формат');
				}
			}
			break;
	}

	return errors;
}

// Отримання всіх товарів з фільтрацією
export async function getAllProducts(req, res) {
	try {
		const {
			category,
			product_type,
			is_active = 1,
			limit = 50,
			offset = 0
		} = req.query;

		let query = 'SELECT * FROM products WHERE is_active = ?';
		const params = [is_active];

		// Додаємо фільтри
		if (category) {
			query += ' AND category = ?';
			params.push(category);
		}

		if (product_type && PRODUCT_TYPES.includes(product_type)) {
			query += ' AND product_type = ?';
			params.push(product_type);
		}

		// Сортування та пагінація
		query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
		params.push(parseInt(limit), parseInt(offset));

		const [products] = await pool.query(query, params);

		// Форматуємо продукти
		const formattedProducts = products.map(product => ({
			...product,
			images: JSON.parse(product.images || '[]'),
			items_data: product.items_data ? JSON.parse(product.items_data) : null,
			execution_config: product.execution_config ? JSON.parse(product.execution_config) : null
		}));

		// Отримуємо загальну кількість для пагінації
		let countQuery = 'SELECT COUNT(*) as total FROM products WHERE is_active = ?';
		const countParams = [is_active];

		if (category) {
			countQuery += ' AND category = ?';
			countParams.push(category);
		}

		if (product_type) {
			countQuery += ' AND product_type = ?';
			countParams.push(product_type);
		}

		const [countResult] = await pool.query(countQuery, countParams);

		return res.status(200).json({
			products: formattedProducts,
			pagination: {
				total: countResult[0].total,
				limit: parseInt(limit),
				offset: parseInt(offset),
				hasMore: countResult[0].total > (parseInt(offset) + parseInt(limit))
			}
		});
	} catch (err) {
		console.error('Error getting products:', err);
		return res.status(500).json({ message: 'Error fetching products' });
	}
}

// Отримання товару за ID
export async function getProductById(req, res) {
	const { id } = req.params;

	try {
		const [product] = await pool.query(
			'SELECT * FROM products WHERE id = ? AND is_active = 1',
			[id]
		);

		if (product.length === 0) {
			return res.status(404).json({ message: 'Product not found' });
		}

		// Форматуємо продукт
		const formattedProduct = {
			...product[0],
			images: JSON.parse(product[0].images || '[]'),
			items_data: product[0].items_data ? JSON.parse(product[0].items_data) : null,
			execution_config: product[0].execution_config ? JSON.parse(product[0].execution_config) : null
		};

		return res.status(200).json({ product: formattedProduct });
	} catch (err) {
		console.error('Error getting product:', err);
		return res.status(500).json({ message: 'Error fetching product' });
	}
}

// Створення нового товару
export async function createProduct(req, res) {
	const {
		name,
		description,
		product_type = 'item',
		item_id,
		items_data,
		game_price,
		donate_price,
		max_purchases_per_player = 0,
		category,
		execution_config,
		subscription_duration,
		auto_execute = 1,
		requires_manual_approval = 0
	} = req.body;

	// Основна валідація
	if (!name || !PRODUCT_TYPES.includes(product_type)) {
		return res.status(400).json({
			message: 'Відсутні обов\'язкові поля або некоректний тип продукту',
			valid_types: PRODUCT_TYPES
		});
	}

	if (!game_price && !donate_price) {
		return res.status(400).json({
			message: 'Має бути вказана хоча б одна ціна (game_price або donate_price)'
		});
	}

	// Валідація залежно від типу продукту
	const productData = {
		name, description, product_type, item_id, items_data,
		game_price, donate_price, execution_config, subscription_duration
	};

	const validationErrors = validateProductData(product_type, productData);
	if (validationErrors.length > 0) {
		return res.status(400).json({
			message: 'Помилки валідації',
			errors: validationErrors
		});
	}

	// Обробка завантажених зображень
	const imageUrls = req.processedImages || [];
	const imagesJson = JSON.stringify(imageUrls);

	const now = Math.floor(Date.now() / 1000);

	try {
		const [result] = await pool.query(`
            INSERT INTO products (
                name, description, images, product_type, item_id, items_data,
                game_price, donate_price, max_purchases_per_player, category,
                execution_config, subscription_duration, auto_execute, 
                requires_manual_approval, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
			name,
			description,
			imagesJson,
			product_type,
			item_id || null,
			productData.items_data || null,
			game_price || null,
			donate_price || null,
			max_purchases_per_player,
			category || null,
			typeof execution_config === 'object' ? JSON.stringify(execution_config) : execution_config || null,
			subscription_duration || null,
			auto_execute,
			requires_manual_approval,
			now
		]);

		return res.status(201).json({
			message: 'Product created successfully',
			product_id: result.insertId,
			product_type,
			images: imageUrls
		});
	} catch (err) {
		console.error('Error creating product:', err);
		return res.status(500).json({ message: 'Error creating product' });
	}
}

// Оновлення товару
export async function updateProduct(req, res) {
	const { id } = req.params;
	const {
		name,
		description,
		product_type,
		item_id,
		items_data,
		game_price,
		donate_price,
		max_purchases_per_player,
		is_active,
		category,
		execution_config,
		subscription_duration,
		auto_execute,
		requires_manual_approval,
		remove_images
	} = req.body;

	const now = Math.floor(Date.now() / 1000);

	try {
		// Отримуємо існуючий продукт
		const [product] = await pool.query('SELECT * FROM products WHERE id = ?', [id]);

		if (product.length === 0) {
			return res.status(404).json({ message: 'Product not found' });
		}

		const existingProduct = product[0];

		// Валідація типу продукту, якщо він змінюється
		if (product_type && product_type !== existingProduct.product_type) {
			if (!PRODUCT_TYPES.includes(product_type)) {
				return res.status(400).json({
					message: 'Некоректний тип продукту',
					valid_types: PRODUCT_TYPES
				});
			}

			// Валідація нових даних для нового типу
			const newProductData = {
				name: name || existingProduct.name,
				product_type,
				item_id: item_id || existingProduct.item_id,
				items_data: items_data || existingProduct.items_data,
				execution_config: execution_config || existingProduct.execution_config,
				subscription_duration: subscription_duration || existingProduct.subscription_duration
			};

			const validationErrors = validateProductData(product_type, newProductData);
			if (validationErrors.length > 0) {
				return res.status(400).json({
					message: 'Помилки валідації для нового типу продукту',
					errors: validationErrors
				});
			}
		}

		// Обробляємо зображення (ваш існуючий код)
		let currentImages = JSON.parse(existingProduct.images || '[]');

		if (remove_images && Array.isArray(remove_images)) {
			const indicesToRemove = remove_images.map(idx => parseInt(idx));

			indicesToRemove.forEach(idx => {
				if (idx >= 0 && idx < currentImages.length) {
					const imagePath = path.join(process.cwd(), 'public', currentImages[idx]);
					if (fs.existsSync(imagePath)) {
						fs.unlinkSync(imagePath);
					}
				}
			});

			currentImages = currentImages.filter((_, idx) => !indicesToRemove.includes(idx));
		}

		if (req.processedImages && req.processedImages.length > 0) {
			currentImages = [...currentImages, ...req.processedImages];
		}

		// Підготовка JSON полів
		const finalItemsData = items_data
			? (typeof items_data === 'object' ? JSON.stringify(items_data) : items_data)
			: existingProduct.items_data;

		const finalExecutionConfig = execution_config
			? (typeof execution_config === 'object' ? JSON.stringify(execution_config) : execution_config)
			: existingProduct.execution_config;

		// Оновлюємо продукт в базі даних
		await pool.query(`
            UPDATE products SET 
                name = ?, description = ?, images = ?, product_type = ?, 
                item_id = ?, items_data = ?, game_price = ?, donate_price = ?, 
                max_purchases_per_player = ?, is_active = ?, category = ?,
                execution_config = ?, subscription_duration = ?, 
                auto_execute = ?, requires_manual_approval = ?, updated_at = ? 
            WHERE id = ?
        `, [
			name !== undefined ? name : existingProduct.name,
			description !== undefined ? description : existingProduct.description,
			JSON.stringify(currentImages),
			product_type !== undefined ? product_type : existingProduct.product_type,
			item_id !== undefined ? item_id : existingProduct.item_id,
			finalItemsData,
			game_price !== undefined ? game_price : existingProduct.game_price,
			donate_price !== undefined ? donate_price : existingProduct.donate_price,
			max_purchases_per_player !== undefined ? max_purchases_per_player : existingProduct.max_purchases_per_player,
			is_active !== undefined ? is_active : existingProduct.is_active,
			category !== undefined ? category : existingProduct.category,
			finalExecutionConfig,
			subscription_duration !== undefined ? subscription_duration : existingProduct.subscription_duration,
			auto_execute !== undefined ? auto_execute : existingProduct.auto_execute,
			requires_manual_approval !== undefined ? requires_manual_approval : existingProduct.requires_manual_approval,
			now,
			id
		]);

		return res.status(200).json({
			message: 'Product updated successfully',
			images: currentImages
		});
	} catch (err) {
		console.error('Error updating product:', err);
		return res.status(500).json({ message: 'Error updating product' });
	}
}

// Видалення товару (ваш існуючий код залишається)
export async function deleteProduct(req, res) {
	const { id } = req.params;

	try {
		const [product] = await pool.query('SELECT * FROM products WHERE id = ?', [id]);

		if (product.length === 0) {
			return res.status(404).json({ message: 'Product not found' });
		}

		// Видаляємо фізичні файли зображень
		const images = JSON.parse(product[0].images || '[]');
		images.forEach(imageUrl => {
			const imagePath = path.join(process.cwd(), 'public', imageUrl);
			if (fs.existsSync(imagePath)) {
				fs.unlinkSync(imagePath);
			}
		});

		// Видаляємо запис з бази даних
		await pool.query('DELETE FROM products WHERE id = ?', [id]);

		return res.status(200).json({ message: 'Product deleted successfully' });
	} catch (err) {
		console.error('Error deleting product:', err);
		return res.status(500).json({ message: 'Error deleting product' });
	}
}

// Додаткові методи для роботи з категоріями та типами
export async function getProductCategories(req, res) {
	try {
		const [categories] = await pool.query(`
            SELECT category, COUNT(*) as count 
            FROM products 
            WHERE category IS NOT NULL AND is_active = 1 
            GROUP BY category 
            ORDER BY count DESC
        `);

		return res.status(200).json({
			categories: categories,
			valid_categories: VALID_CATEGORIES
		});
	} catch (err) {
		console.error('Error getting categories:', err);
		return res.status(500).json({ message: 'Error fetching categories' });
	}
}

export async function getProductTypes(req, res) {
	try {
		const [types] = await pool.query(`
            SELECT product_type, COUNT(*) as count 
            FROM products 
            WHERE is_active = 1 
            GROUP BY product_type 
            ORDER BY count DESC
        `);

		return res.status(200).json({
			types: types,
			valid_types: PRODUCT_TYPES
		});
	} catch (err) {
		console.error('Error getting product types:', err);
		return res.status(500).json({ message: 'Error fetching product types' });
	}
}