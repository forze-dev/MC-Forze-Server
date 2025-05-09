import { pool } from '../services/db.service.js';
import fs from 'fs';
import path from 'path';

// Отримання всіх товарів
export async function getAllProducts(req, res) {
	try {
		const [products] = await pool.query('SELECT * FROM products WHERE is_active = 1');

		// Парсимо JSON рядки в масиви для поля images
		const formattedProducts = products.map(product => ({
			...product,
			images: JSON.parse(product.images || '[]')
		}));

		return res.status(200).json({ products: formattedProducts });
	} catch (err) {
		console.error('Error getting products:', err);
		return res.status(500).json({ message: 'Error fetching products' });
	}
}

// Отримання товару за ID
export async function getProductById(req, res) {
	const { id } = req.params;

	try {
		const [product] = await pool.query('SELECT * FROM products WHERE id = ? AND is_active = 1', [id]);

		if (product.length === 0) {
			return res.status(404).json({ message: 'Product not found' });
		}

		// Парсимо JSON рядок в масив для поля images
		const formattedProduct = {
			...product[0],
			images: JSON.parse(product[0].images || '[]')
		};

		return res.status(200).json({ product: formattedProduct });
	} catch (err) {
		console.error('Error getting product:', err);
		return res.status(500).json({ message: 'Error fetching product' });
	}
}

// Створення нового товару
export async function createProduct(req, res) {
	const { name, description, item_id, game_price, donate_price, max_purchases_per_player, category } = req.body;

	// Перевірка обов'язкових полів
	if (!name || !item_id || (!game_price && !donate_price)) {
		return res.status(400).json({ message: 'Missing required fields' });
	}

	// Обробка завантажених зображень
	const imageUrls = req.processedImages || [];
	const imagesJson = JSON.stringify(imageUrls);

	const now = Math.floor(Date.now() / 1000);

	try {
		const [result] = await pool.query(
			'INSERT INTO products (name, description, images, item_id, game_price, donate_price, max_purchases_per_player, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
			[name, description, imagesJson, item_id, game_price, donate_price, max_purchases_per_player || 0, category, now]
		);

		return res.status(201).json({
			message: 'Product created',
			product_id: result.insertId,
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
	const { name, description, item_id, game_price, donate_price, max_purchases_per_player, is_active, category, remove_images } = req.body;

	const now = Math.floor(Date.now() / 1000);

	try {
		// Отримуємо існуючий продукт
		const [product] = await pool.query('SELECT * FROM products WHERE id = ?', [id]);

		if (product.length === 0) {
			return res.status(404).json({ message: 'Product not found' });
		}

		// Обробляємо зображення
		let currentImages = JSON.parse(product[0].images || '[]');

		// Якщо видаляємо зображення (передаємо індекси зображень для видалення)
		if (remove_images && Array.isArray(remove_images)) {
			// Конвертуємо індекси в числа
			const indicesToRemove = remove_images.map(idx => parseInt(idx));

			// Видаляємо фізичні файли
			indicesToRemove.forEach(idx => {
				if (idx >= 0 && idx < currentImages.length) {
					const imagePath = path.join(process.cwd(), 'public', currentImages[idx]);
					if (fs.existsSync(imagePath)) {
						fs.unlinkSync(imagePath);
					}
				}
			});

			// Фільтруємо масив URL зображень, щоб видалити вказані
			currentImages = currentImages.filter((_, idx) => !indicesToRemove.includes(idx));
		}

		// Додаємо нові зображення, якщо вони є
		if (req.processedImages && req.processedImages.length > 0) {
			currentImages = [...currentImages, ...req.processedImages];
		}

		// Оновлюємо продукт в базі даних
		await pool.query(
			'UPDATE products SET name = ?, description = ?, images = ?, item_id = ?, game_price = ?, donate_price = ?, max_purchases_per_player = ?, is_active = ?, category = ?, updated_at = ? WHERE id = ?',
			[
				name || product[0].name,
				description !== undefined ? description : product[0].description,
				JSON.stringify(currentImages),
				item_id || product[0].item_id,
				game_price !== undefined ? game_price : product[0].game_price,
				donate_price !== undefined ? donate_price : product[0].donate_price,
				max_purchases_per_player !== undefined ? max_purchases_per_player : product[0].max_purchases_per_player,
				is_active !== undefined ? is_active : product[0].is_active,
				category !== undefined ? category : product[0].category,
				now,
				id
			]
		);

		return res.status(200).json({
			message: 'Product updated',
			images: currentImages
		});
	} catch (err) {
		console.error('Error updating product:', err);
		return res.status(500).json({ message: 'Error updating product' });
	}
}

// Видалення товару
export async function deleteProduct(req, res) {
	const { id } = req.params;

	try {
		// Отримуємо продукт для видалення його зображень
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

		return res.status(200).json({ message: 'Product deleted' });
	} catch (err) {
		console.error('Error deleting product:', err);
		return res.status(500).json({ message: 'Error deleting product' });
	}
}