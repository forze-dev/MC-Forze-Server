// controllers/promocodes.controller.js
// Контролер для роботи з промокодами - валідація, створення, керування

import { pool } from '../services/db.service.js';

/**
 * Перевірка валідності промокоду перед покупкою
 * GET /shop/promocode/validate?code=MYCODE&productId=123
 */
export async function validatePromocode(req, res) {
	try {
		const { code, productId } = req.query;

		if (!code) {
			return res.status(400).json({ message: 'Промокод не вказано' });
		}

		const conn = await pool.getConnection();

		try {
			// Шукаємо активний промокод
			const [promocodes] = await conn.query(
				`SELECT * FROM promocodes 
                 WHERE code = ? AND is_active = 1 
                 AND (start_date IS NULL OR start_date <= ?) 
                 AND (end_date IS NULL OR end_date >= ?) 
                 AND (uses_left IS NULL OR uses_left > 0)`,
				[code, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)]
			);

			if (promocodes.length === 0) {
				return res.status(404).json({
					valid: false,
					message: 'Промокод недійсний або закінчився'
				});
			}

			const promocode = promocodes[0];

			// Перевіряємо чи застосовується до конкретного товару
			if (productId && promocode.applicable_products) {
				const applicableProducts = JSON.parse(promocode.applicable_products);
				if (!applicableProducts.includes(parseInt(productId))) {
					return res.status(400).json({
						valid: false,
						message: 'Промокод не застосовується до цього товару'
					});
				}
			}

			return res.status(200).json({
				valid: true,
				discount_percent: promocode.discount_percent,
				message: `Промокод дає знижку ${promocode.discount_percent}%`,
				promocode: {
					id: promocode.id,
					code: promocode.code,
					discount_percent: promocode.discount_percent,
					uses_left: promocode.uses_left
				}
			});

		} finally {
			conn.release();
		}

	} catch (error) {
		console.error('Помилка валідації промокоду:', error);
		return res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
}

/**
 * Створення нового промокоду (тільки для адмінів)
 * POST /admin/promocodes
 */
export async function createPromocode(req, res) {
	try {
		const {
			code,
			discount_percent,
			uses_left = null,
			applicable_products = null,
			start_date = null,
			end_date = null
		} = req.body;

		// Валідація
		if (!code || !discount_percent) {
			return res.status(400).json({
				message: 'Код промокоду та відсоток знижки є обов\'язковими'
			});
		}

		if (discount_percent < 1 || discount_percent > 100) {
			return res.status(400).json({
				message: 'Знижка повинна бути від 1% до 100%'
			});
		}

		const conn = await pool.getConnection();

		try {
			// Перевіряємо чи не існує вже такий код
			const [existing] = await conn.query(
				'SELECT id FROM promocodes WHERE code = ?',
				[code]
			);

			if (existing.length > 0) {
				return res.status(409).json({
					message: 'Промокод з таким кодом вже існує'
				});
			}

			// Створюємо промокод
			const now = Math.floor(Date.now() / 1000);
			const [result] = await conn.query(
				`INSERT INTO promocodes 
                 (code, discount_percent, uses_left, applicable_products, 
                  start_date, end_date, is_active, created_at) 
                 VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
				[
					code,
					discount_percent,
					uses_left,
					applicable_products ? JSON.stringify(applicable_products) : null,
					start_date,
					end_date,
					now
				]
			);

			return res.status(201).json({
				message: 'Промокод успішно створено',
				promocode: {
					id: result.insertId,
					code,
					discount_percent,
					uses_left
				}
			});

		} finally {
			conn.release();
		}

	} catch (error) {
		console.error('Помилка створення промокоду:', error);
		return res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
}

/**
 * Отримання всіх промокодів (для адмінів)
 * GET /admin/promocodes
 */
export async function getAllPromocodes(req, res) {
	try {
		const { page = 1, limit = 20, active_only = false } = req.query;
		const offset = (page - 1) * limit;

		let query = 'SELECT * FROM promocodes';
		const params = [];

		if (active_only === 'true') {
			query += ' WHERE is_active = 1';
		}

		query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
		params.push(parseInt(limit), parseInt(offset));

		const [promocodes] = await pool.query(query, params);

		// Парсимо JSON поля
		const formattedPromocodes = promocodes.map(promo => ({
			...promo,
			applicable_products: promo.applicable_products
				? JSON.parse(promo.applicable_products)
				: null
		}));

		return res.status(200).json({
			promocodes: formattedPromocodes,
			pagination: {
				page: parseInt(page),
				limit: parseInt(limit)
			}
		});

	} catch (error) {
		console.error('Помилка отримання промокодів:', error);
		return res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
}

/**
 * Деактивація промокоду
 * PATCH /admin/promocodes/:id/deactivate
 */
export async function deactivatePromocode(req, res) {
	try {
		const { id } = req.params;

		const [result] = await pool.query(
			'UPDATE promocodes SET is_active = 0 WHERE id = ?',
			[id]
		);

		if (result.affectedRows === 0) {
			return res.status(404).json({ message: 'Промокод не знайдено' });
		}

		return res.status(200).json({ message: 'Промокод деактивовано' });

	} catch (error) {
		console.error('Помилка деактивації промокоду:', error);
		return res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
}