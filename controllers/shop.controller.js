import { pool } from '../services/db.service.js';
import shopService from '../services/shop.service.js';

/**
 * Покупка товару
 */
export async function purchaseProduct(req, res) {
	try {
		const { productId, paymentCurrency, promocodeId } = req.body;
		const telegramId = req.player.telegramId;
		const minecraftNick = req.player.userData.minecraft_nick;

		// Валідація обов'язкових полів
		if (!productId || !paymentCurrency) {
			return res.status(400).json({
				message: 'Відсутні обов\'язкові поля (productId, paymentCurrency)'
			});
		}

		// Перевірка валютного типу
		if (!['game', 'donate'].includes(paymentCurrency)) {
			return res.status(400).json({
				message: 'Невірний тип валюти. Використовуйте game або donate'
			});
		}

		const conn = await pool.getConnection();

		try {
			await conn.beginTransaction();

			// 1. Отримуємо інформацію про товар
			const [products] = await conn.query(
				'SELECT * FROM products WHERE id = ? AND is_active = 1',
				[productId]
			);

			if (products.length === 0) {
				await conn.rollback();
				conn.release();
				return res.status(404).json({ message: 'Товар не знайдено або неактивний' });
			}

			const product = products[0];

			// 2. Перевіряємо чи є ціна для обраної валюти
			const price = paymentCurrency === 'game' ? product.game_price : product.donate_price;

			if (!price || price <= 0) {
				await conn.rollback();
				conn.release();
				return res.status(400).json({
					message: `Товар недоступний для покупки за ${paymentCurrency === 'game' ? 'ігрову' : 'донатну'} валюту`
				});
			}

			// 3. Перевіряємо ліміт покупок для гравця
			if (product.max_purchases_per_player > 0) {
				const [purchaseCount] = await conn.query(
					'SELECT purchases_made FROM purchase_limits WHERE telegram_id = ? AND product_id = ?',
					[telegramId, productId]
				);

				const currentPurchases = purchaseCount.length > 0 ? purchaseCount[0].purchases_made : 0;

				if (currentPurchases >= product.max_purchases_per_player) {
					await conn.rollback();
					conn.release();
					return res.status(400).json({
						message: `Досягнуто максимальну кількість покупок цього товару (${product.max_purchases_per_player})`
					});
				}
			}

			// 4. Обробляємо знижки
			let appliedDiscountPercent = 0;
			let finalPrice = price;

			// Отримуємо знижку гравця від рефералів
			const [playerDiscount] = await conn.query(
				'SELECT discount_percent FROM discounts WHERE telegram_id = ?',
				[telegramId]
			);

			if (playerDiscount.length > 0) {
				appliedDiscountPercent = playerDiscount[0].discount_percent;
			}

			// Перевіряємо промокод (якщо вказано)
			if (promocodeId) {
				const [promocode] = await conn.query(
					'SELECT * FROM promocodes WHERE id = ? AND is_active = 1 AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?) AND (uses_left IS NULL OR uses_left > 0)',
					[promocodeId, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)]
				);

				if (promocode.length > 0) {
					const promo = promocode[0];

					// Перевіряємо чи можна застосувати промокод до цього товару
					if (promo.applicable_products) {
						const applicableProducts = JSON.parse(promo.applicable_products);
						if (!applicableProducts.includes(productId)) {
							await conn.rollback();
							conn.release();
							return res.status(400).json({ message: 'Промокод не застосовується до цього товару' });
						}
					}

					// Застосовуємо найбільшу знижку
					if (promo.discount_percent > appliedDiscountPercent) {
						appliedDiscountPercent = promo.discount_percent;
					}

					// Зменшуємо кількість використань промокоду
					if (promo.uses_left !== null) {
						await conn.query(
							'UPDATE promocodes SET uses_left = uses_left - 1 WHERE id = ?',
							[promocodeId]
						);
					}
				} else {
					await conn.rollback();
					conn.release();
					return res.status(400).json({ message: 'Промокод недійсний або закінчився' });
				}
			}

			// Застосовуємо знижку
			if (appliedDiscountPercent > 0) {
				finalPrice = Math.ceil(price * (100 - appliedDiscountPercent) / 100);
			}

			// 5. Перевіряємо баланс гравця
			const currentBalance = paymentCurrency === 'game'
				? req.player.userData.game_balance
				: req.player.userData.donate_balance;

			if (currentBalance < finalPrice) {
				await conn.rollback();
				conn.release();
				return res.status(400).json({
					message: `Недостатньо коштів. Потрібно: ${finalPrice}, у вас: ${currentBalance}`
				});
			}

			// 6. Списуємо кошти з балансу
			const balanceField = paymentCurrency === 'game' ? 'game_balance' : 'donate_balance';
			await conn.query(
				`UPDATE users SET ${balanceField} = ${balanceField} - ?, updated_at = ? WHERE telegram_id = ?`,
				[finalPrice, Math.floor(Date.now() / 1000), telegramId]
			);

			// 7. Створюємо запис покупки
			const now = Math.floor(Date.now() / 1000);
			const [purchaseResult] = await conn.query(
				`INSERT INTO purchases 
				 (telegram_id, minecraft_nick, product_id, quantity, paid_game_price, paid_donate_price, 
				  payment_currency, applied_discount_percent, promocode_id, purchased_at, status) 
				 VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'completed')`,
				[
					telegramId,
					minecraftNick,
					productId,
					paymentCurrency === 'game' ? finalPrice : null,
					paymentCurrency === 'donate' ? finalPrice : null,
					paymentCurrency,
					appliedDiscountPercent,
					promocodeId || null,
					now
				]
			);

			const purchaseId = purchaseResult.insertId;

			// 8. Оновлюємо ліміт покупок
			if (product.max_purchases_per_player > 0) {
				await conn.query(
					`INSERT INTO purchase_limits (telegram_id, product_id, purchases_made, updated_at) 
					 VALUES (?, ?, 1, ?) 
					 ON DUPLICATE KEY UPDATE purchases_made = purchases_made + 1, updated_at = ?`,
					[telegramId, productId, now, now]
				);
			}

			await conn.commit();

			// 9. Обробляємо товар через ShopService
			console.log(`💰 Покупка завершена: ${minecraftNick} купив ${product.name} за ${finalPrice} ${paymentCurrency}`);

			const shopResult = await shopService.processPurchase({
				telegramId,
				productId,
				minecraftNick,
				quantity: 1,
				purchaseId
			});

			// 10. Формуємо відповідь
			const response = {
				message: 'Покупка успішно завершена!',
				purchase: {
					id: purchaseId,
					product: {
						id: product.id,
						name: product.name,
						type: product.product_type
					},
					price: {
						original: price,
						final: finalPrice,
						currency: paymentCurrency,
						discount: appliedDiscountPercent
					},
					purchasedAt: now
				},
				execution: {
					success: shopResult.success,
					message: shopResult.message || null,
					autoExecuted: shopResult.autoExecuted || false,
					requiresManualAction: shopResult.requiresManualAction || false
				}
			};

			if (shopResult.executionResults) {
				response.execution.results = shopResult.executionResults;
			}

			if (!shopResult.success) {
				response.execution.error = shopResult.error;
			}

			return res.status(200).json(response);

		} catch (error) {
			await conn.rollback();
			throw error;
		} finally {
			conn.release();
		}

	} catch (error) {
		console.error('❌ Помилка покупки товару:', error);
		return res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
}

/**
 * Отримання історії покупок гравця
 */
export async function getPurchaseHistory(req, res) {
	try {
		const telegramId = req.player.telegramId;
		const { page = 1, limit = 10 } = req.query;

		const offset = (page - 1) * limit;

		const conn = await pool.getConnection();

		try {
			// Отримуємо покупки з пагінацією
			const [purchases] = await conn.query(
				`SELECT 
					p.id, p.quantity, p.paid_game_price, p.paid_donate_price, 
					p.payment_currency, p.applied_discount_percent, p.purchased_at, p.status,
					pr.name as product_name, pr.product_type, pr.category
				FROM purchases p
				JOIN products pr ON p.product_id = pr.id
				WHERE p.telegram_id = ?
				ORDER BY p.purchased_at DESC
				LIMIT ? OFFSET ?`,
				[telegramId, parseInt(limit), parseInt(offset)]
			);

			// Отримуємо загальну кількість покупок
			const [totalCount] = await conn.query(
				'SELECT COUNT(*) as total FROM purchases WHERE telegram_id = ?',
				[telegramId]
			);

			const total = totalCount[0].total;
			const totalPages = Math.ceil(total / limit);

			return res.status(200).json({
				purchases: purchases.map(purchase => ({
					id: purchase.id,
					product: {
						name: purchase.product_name,
						type: purchase.product_type,
						category: purchase.category
					},
					quantity: purchase.quantity,
					price: purchase.paid_game_price || purchase.paid_donate_price,
					currency: purchase.payment_currency,
					discount: purchase.applied_discount_percent,
					status: purchase.status,
					purchasedAt: purchase.purchased_at
				})),
				pagination: {
					currentPage: parseInt(page),
					totalPages,
					totalItems: total,
					hasNextPage: page < totalPages,
					hasPreviousPage: page > 1
				}
			});

		} finally {
			conn.release();
		}

	} catch (error) {
		console.error('❌ Помилка отримання історії покупок:', error);
		return res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
}

/**
 * Отримання статистики покупок (для адмінів)
 */
export async function getPurchaseStatistics(req, res) {
	try {
		const { period = '7d' } = req.query; // 7d, 30d, 90d, all

		let dateCondition = '';
		const now = Math.floor(Date.now() / 1000);

		switch (period) {
			case '7d':
				dateCondition = `AND purchased_at >= ${now - 7 * 24 * 60 * 60}`;
				break;
			case '30d':
				dateCondition = `AND purchased_at >= ${now - 30 * 24 * 60 * 60}`;
				break;
			case '90d':
				dateCondition = `AND purchased_at >= ${now - 90 * 24 * 60 * 60}`;
				break;
			case 'all':
			default:
				dateCondition = '';
		}

		const conn = await pool.getConnection();

		try {
			// Загальна статистика
			const [generalStats] = await conn.query(`
				SELECT 
					COUNT(*) as total_purchases,
					SUM(CASE WHEN payment_currency = 'game' THEN paid_game_price ELSE 0 END) as total_game_revenue,
					SUM(CASE WHEN payment_currency = 'donate' THEN paid_donate_price ELSE 0 END) as total_donate_revenue,
					COUNT(DISTINCT telegram_id) as unique_buyers
				FROM purchases 
				WHERE status = 'completed' ${dateCondition}
			`);

			// Статистика по типах товарів
			const [productTypeStats] = await conn.query(`
				SELECT 
					pr.product_type,
					COUNT(*) as purchases_count,
					SUM(CASE WHEN p.payment_currency = 'game' THEN p.paid_game_price ELSE p.paid_donate_price END) as total_revenue
				FROM purchases p
				JOIN products pr ON p.product_id = pr.id
				WHERE p.status = 'completed' ${dateCondition}
				GROUP BY pr.product_type
				ORDER BY purchases_count DESC
			`);

			// Топ товарів
			const [topProducts] = await conn.query(`
				SELECT 
					pr.name,
					pr.product_type,
					COUNT(*) as purchases_count,
					SUM(CASE WHEN p.payment_currency = 'game' THEN p.paid_game_price ELSE p.paid_donate_price END) as total_revenue
				FROM purchases p
				JOIN products pr ON p.product_id = pr.id
				WHERE p.status = 'completed' ${dateCondition}
				GROUP BY p.product_id
				ORDER BY purchases_count DESC
				LIMIT 10
			`);

			// Статистика виконання товарів
			const executionStats = await shopService.getExecutionStats();

			return res.status(200).json({
				period,
				general: generalStats[0],
				productTypes: productTypeStats,
				topProducts,
				executionStats
			});

		} finally {
			conn.release();
		}

	} catch (error) {
		console.error('❌ Помилка отримання статистики покупок:', error);
		return res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
}

/**
 * Отримання деталей конкретної покупки
 */
export async function getPurchaseDetails(req, res) {
	try {
		const { purchaseId } = req.params;
		const telegramId = req.player.telegramId;
		const isAdmin = req.isAdmin || false;

		const conn = await pool.getConnection();

		try {
			// Базовий запит
			let query = `
				SELECT 
					p.id, p.telegram_id, p.minecraft_nick, p.quantity, 
					p.paid_game_price, p.paid_donate_price, p.payment_currency, 
					p.applied_discount_percent, p.purchased_at, p.status,
					pr.name as product_name, pr.description as product_description,
					pr.product_type, pr.category,
					promo.code as promocode_used
				FROM purchases p
				JOIN products pr ON p.product_id = pr.id
				LEFT JOIN promocodes promo ON p.promocode_id = promo.id
				WHERE p.id = ?
			`;

			const params = [purchaseId];

			// Якщо не адмін, обмежуємо доступ тільки до власних покупок
			if (!isAdmin) {
				query += ' AND p.telegram_id = ?';
				params.push(telegramId);
			}

			const [purchases] = await conn.query(query, params);

			if (purchases.length === 0) {
				return res.status(404).json({ message: 'Покупку не знайдено' });
			}

			const purchase = purchases[0];

			// Отримуємо інформацію про виконання
			const [executions] = await conn.query(
				`SELECT 
					execution_type, execution_status, command_executed, 
					execution_result, executed_at, retry_count, created_at
				FROM product_executions 
				WHERE purchase_id = ?
				ORDER BY created_at DESC`,
				[purchaseId]
			);

			const response = {
				id: purchase.id,
				buyer: {
					telegramId: purchase.telegram_id,
					minecraftNick: purchase.minecraft_nick
				},
				product: {
					name: purchase.product_name,
					description: purchase.product_description,
					type: purchase.product_type,
					category: purchase.category
				},
				purchase: {
					quantity: purchase.quantity,
					price: purchase.paid_game_price || purchase.paid_donate_price,
					currency: purchase.payment_currency,
					discount: purchase.applied_discount_percent,
					promocode: purchase.promocode_used,
					status: purchase.status,
					purchasedAt: purchase.purchased_at
				},
				executions: executions.map(exec => ({
					type: exec.execution_type,
					status: exec.execution_status,
					command: exec.command_executed,
					result: exec.execution_result ? JSON.parse(exec.execution_result) : null,
					executedAt: exec.executed_at,
					retryCount: exec.retry_count,
					createdAt: exec.created_at
				}))
			};

			return res.status(200).json(response);

		} finally {
			conn.release();
		}

	} catch (error) {
		console.error('❌ Помилка отримання деталей покупки:', error);
		return res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
}