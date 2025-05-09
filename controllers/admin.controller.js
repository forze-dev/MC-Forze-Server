import { pool } from '../services/db.service.js';
import jwt from 'jsonwebtoken';
import { comparePassword } from '../utils/crypto.js';
import { generateAdminToken } from '../services/token.service.js';

/**
 * Авторизація адміністратора
 */
export async function adminLogin(req, res) {
	try {
		const { minecraftNick, password } = req.body;

		// Перевірка обов'язкових полів
		if (!minecraftNick || !password) {
			return res.status(400).json({ message: 'Відсутні обов\'язкові поля (minecraftNick, password)' });
		}

		// Отримуємо інформацію про гравця з authme
		const [authUsers] = await pool.query('SELECT * FROM authme WHERE username = ?', [minecraftNick]);

		if (authUsers.length === 0) {
			return res.status(401).json({ message: 'Невірний логін або пароль' });
		}

		// Перевіряємо пароль
		const isPasswordValid = comparePassword(password, authUsers[0].password);

		if (!isPasswordValid) {
			return res.status(401).json({ message: 'Невірний логін або пароль' });
		}

		// Отримуємо інформацію про гравця з users
		const [users] = await pool.query('SELECT * FROM users WHERE minecraft_nick = ?', [minecraftNick]);

		if (users.length === 0) {
			return res.status(404).json({ message: 'Гравця не знайдено в системі' });
		}

		// Перевіряємо чи є гравець адміністратором
		const [admins] = await pool.query(
			'SELECT * FROM admins WHERE telegram_id = ? AND is_active = 1',
			[users[0].telegram_id]
		);

		if (admins.length === 0) {
			return res.status(403).json({ message: 'У вас немає прав адміністратора' });
		}

		// Генеруємо токен для адміністратора
		const admin = { ...admins[0], telegram_id: users[0].telegram_id };
		const token = generateAdminToken(admin);

		// Оновлюємо дані останнього входу
		const now = Math.floor(Date.now() / 1000);
		await pool.query('UPDATE authme SET lastlogin = ? WHERE username = ?', [now * 1000, minecraftNick]);
		await pool.query('UPDATE admins SET updated_at = ? WHERE id = ?', [now, admins[0].id]);

		return res.status(200).json({
			message: 'Успішна авторизація адміністратора',
			token,
			admin: {
				id: admins[0].id,
				telegramId: users[0].telegram_id,
				nickname: admins[0].nickname,
				role: admins[0].role,
				minecraftNick: users[0].minecraft_nick
			}
		});

	} catch (err) {
		console.error('Error during admin login:', err);
		return res.status(500).json({ message: 'Помилка авторизації адміністратора' });
	}
}

/**
 * Перевірка токена адміністратора
 */
export async function verifyAdminToken(req, res) {
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
			if (!decoded.isAdmin) {
				return res.status(403).json({ message: 'Доступ заборонено: необхідні права адміністратора' });
			}

			// Перевіряємо актуальність прав адміністратора в базі даних
			const [admins] = await pool.query(
				'SELECT a.*, u.minecraft_nick FROM admins a JOIN users u ON a.telegram_id = u.telegram_id WHERE a.telegram_id = ? AND a.is_active = 1',
				[decoded.telegramId]
			);

			if (admins.length === 0) {
				return res.status(403).json({ message: 'Доступ заборонено: адміністраторські права відкликано' });
			}

			return res.status(200).json({
				message: 'Токен адміністратора дійсний',
				admin: {
					id: admins[0].id,
					telegramId: decoded.telegramId,
					nickname: admins[0].nickname,
					role: admins[0].role,
					minecraftNick: admins[0].minecraft_nick
				}
			});

		} catch (error) {
			return res.status(401).json({ message: 'Не авторизовано: недійсний токен' });
		}
	} catch (error) {
		console.error('Помилка перевірки токена адміністратора:', error);
		return res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
}