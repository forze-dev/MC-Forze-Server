import { pool } from '../services/db.service.js';
import jwt from 'jsonwebtoken';

/**
 * Middleware для перевірки токена адміністратора
 */
export const isAdmin = async (req, res, next) => {
	try {
		// Отримуємо токен з заголовка Authorization
		const authHeader = req.headers.authorization;
		if (!authHeader || !authHeader.startsWith('Bearer ')) {
			return res.status(401).json({ message: 'Не авторизовано: токен відсутній' });
		}

		const token = authHeader.split(' ')[1];

		// Перевіряємо JWT токен
		try {
			const decoded = jwt.verify(token, process.env.JWT_SECRET);

			// Перевіряємо чи є роль адміністратора
			if (!decoded.role || decoded.role !== 'admin') {
				return res.status(403).json({ message: 'Доступ заборонено: необхідні права адміністратора' });
			}

			// Додаємо інформацію про адміністратора до запиту
			req.admin = {
				id: decoded.id,
				role: decoded.role
			};

			next();
		} catch (error) {
			return res.status(401).json({ message: 'Не авторизовано: недійсний токен' });
		}
	} catch (error) {
		console.error('Помилка перевірки токена адміністратора:', error);
		return res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
};

/**
 * Middleware для перевірки токена гравця
 */
export const isPlayer = async (req, res, next) => {
	try {
		// Отримуємо токен з заголовка Authorization
		const authHeader = req.headers.authorization;
		if (!authHeader || !authHeader.startsWith('Bearer ')) {
			return res.status(401).json({ message: 'Не авторизовано: токен відсутній' });
		}

		const token = authHeader.split(' ')[1];

		// Перевіряємо JWT токен
		try {
			const decoded = jwt.verify(token, process.env.JWT_SECRET);

			// Перевіряємо наявність telegram_id 
			if (!decoded.telegramId) {
				return res.status(401).json({ message: 'Не авторизовано: недійсний токен' });
			}

			// Перевіряємо існування гравця в базі даних
			const [users] = await pool.query('SELECT * FROM users WHERE telegram_id = ?', [decoded.telegramId]);

			if (users.length === 0) {
				return res.status(404).json({ message: 'Гравця не знайдено' });
			}

			// Додаємо інформацію про гравця до запиту
			req.player = {
				telegramId: decoded.telegramId,
				minecraftNick: users[0].minecraft_nick,
				userData: users[0]
			};

			next();
		} catch (error) {
			return res.status(401).json({ message: 'Не авторизовано: недійсний токен' });
		}
	} catch (error) {
		console.error('Помилка перевірки токена гравця:', error);
		return res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
};

/**
 * Middleware для перевірки, чи токен належить конкретному гравцю або адміністратору
 * Використовується для доступу до особистих даних гравця
 */
export const isPlayerOrAdmin = async (req, res, next) => {
	try {
		// Отримуємо токен з заголовка Authorization
		const authHeader = req.headers.authorization;
		if (!authHeader || !authHeader.startsWith('Bearer ')) {
			return res.status(401).json({ message: 'Не авторизовано: токен відсутній' });
		}

		const token = authHeader.split(' ')[1];

		// Перевіряємо JWT токен
		try {
			const decoded = jwt.verify(token, process.env.JWT_SECRET);

			// Перевіряємо чи це адмін
			if (decoded.role && decoded.role === 'admin') {
				req.isAdmin = true;
				req.admin = {
					id: decoded.id,
					role: decoded.role
				};
				return next();
			}

			// Перевіряємо чи це гравець, чий профіль запитується
			if (decoded.telegramId) {
				// Отримуємо id гравця з параметрів запиту
				const requestedTelegramId = req.params.telegramId || req.body.telegramId;

				if (requestedTelegramId && decoded.telegramId.toString() === requestedTelegramId.toString()) {
					// Перевіряємо існування гравця в базі даних
					const [users] = await pool.query('SELECT * FROM users WHERE telegram_id = ?', [decoded.telegramId]);

					if (users.length === 0) {
						return res.status(404).json({ message: 'Гравця не знайдено' });
					}

					// Додаємо інформацію про гравця до запиту
					req.player = {
						telegramId: decoded.telegramId,
						minecraftNick: users[0].minecraft_nick,
						userData: users[0]
					};

					return next();
				}
			}

			// Якщо це не адмін і не власник профілю
			return res.status(403).json({ message: 'Доступ заборонено: у вас немає прав для цієї дії' });
		} catch (error) {
			return res.status(401).json({ message: 'Не авторизовано: недійсний токен' });
		}
	} catch (error) {
		console.error('Помилка перевірки токена:', error);
		return res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
};