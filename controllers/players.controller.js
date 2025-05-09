import { pool } from '../services/db.service.js';
import { hashPassword } from '../utils/crypto.js';

async function register(req, res) {
	const { telegramId, minecraftNick, password, referrerNick } = req.body;

	// Перевірка на наявність обов'язкових полів
	if (!telegramId || !minecraftNick || !password) {
		return res.status(400).json({ message: 'Missing telegramId, minecraftNick or password' });
	}

	// Хешуємо пароль
	const hashedPassword = hashPassword(password);
	const now = Math.floor(Date.now() / 1000);

	// Змінна для відстеження чи знайдено реферала
	let referrerFound = false;

	try {
		const conn = await pool.getConnection();

		try {
			await conn.beginTransaction();

			// Перевірка на наявність такого нікнейму в authme
			const [existingAuthUser] = await conn.query('SELECT * FROM authme WHERE username = ?', [minecraftNick]);

			if (existingAuthUser.length > 0) {
				await conn.rollback();
				conn.release();
				return res.status(409).json({ message: 'Minecraft username already exists' });
			}

			// Перевірка на наявність такого telegram_id в users
			const [existingTelegramUser] = await conn.query('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);
			if (existingTelegramUser.length > 0) {
				await conn.rollback();
				conn.release();
				return res.status(409).json({ message: 'Telegram user already registered' });
			}

			// Перевіряємо наявність реферала перед додаванням користувача
			let validReferrerNick = null;

			if (referrerNick) {
				// Отримуємо всі можливі збіги з бази даних
				const [referrers] = await conn.query('SELECT * FROM users WHERE minecraft_nick = ?', [referrerNick]);

				// Перевіряємо точний збіг з урахуванням регістру
				const exactMatch = referrers.find(user => user.minecraft_nick === referrerNick);

				if (exactMatch) {
					// Реферал існує з точним збігом регістру - зберігаємо його нік
					validReferrerNick = exactMatch.minecraft_nick;
					referrerFound = true;
				}
			}

			// Додаємо користувача в authme
			await conn.query(
				'INSERT INTO authme (username, realname, password, regdate, regip, x, y, z, world, isLogged, hasSession) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
				[minecraftNick, minecraftNick, hashedPassword, now, '127.0.0.1', 0, 0, 0, 'world', 0, 0]
			);

			// Додаємо користувача в users з перевіреним ніком реферала або null
			await conn.query(
				'INSERT INTO users (telegram_id, username, minecraft_nick, referrer_nick, registered_at, messages_count, donate_balance, game_balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
				[telegramId, null, minecraftNick, validReferrerNick, now, 0, 0, 0]
			);

			// Обробляємо реферальну систему тільки якщо реферал існує
			if (referrerFound) {
				const [referrer] = await conn.query('SELECT * FROM users WHERE minecraft_nick = ?', [validReferrerNick]);
				const referrerTelegramId = referrer[0].telegram_id;

				// Додаємо запис в таблицю referrals 
				await conn.query(
					'INSERT INTO referrals  (referrer_telegram_id, referred_telegram_id, referred_nick, confirmed, created_at) VALUES (?, ?, ?, ?, ?)',
					[referrerTelegramId, telegramId, minecraftNick, 1, now]
				);

				// Оновлюємо кількість рефералів для реферера в таблиці discounts
				const [discountRecord] = await conn.query(
					'SELECT * FROM discounts WHERE telegram_id = ?',
					[referrerTelegramId]
				);

				if (discountRecord.length > 0) {
					// Якщо запис існує, збільшуємо лічильник
					await conn.query(
						'UPDATE discounts SET referrals_count = referrals_count + 1, updated_at = ? WHERE telegram_id = ?',
						[now, referrerTelegramId]
					);

					// Оновлюємо відсоток знижки: 2% за кожного реферала, максимум 40% (20 рефералів)
					await conn.query(
						'UPDATE discounts SET discount_percent = CASE ' +
						'WHEN referrals_count >= 20 THEN 40 ' +
						'ELSE referrals_count * 2 ' +
						'END, updated_at = ? WHERE telegram_id = ?',
						[now, referrerTelegramId]
					);
				} else {
					// Якщо запису нема, створюємо новий з знижкою 2% за першого реферала
					await conn.query(
						'INSERT INTO discounts (telegram_id, referrals_count, discount_percent, updated_at) VALUES (?, ?, ?, ?)',
						[referrerTelegramId, 1, 2, now]
					);
				}
			}

			await conn.commit();
			conn.release();

			return res.status(201).json({
				message: 'User registered',
				minecraft_nick: minecraftNick,
				registered_at: now,
				referrer_applied: referrerFound,
				referrerNick
			});

		} catch (error) {
			await conn.rollback();
			conn.release();
			throw error;
		}
	} catch (err) {
		console.error('Registration error:', err);
		return res.status(500).json({ message: 'Error registering user' });
	}
}

async function addReferrer(req, res) {
	const { telegramId, referrerNick } = req.body;

	// Перевірка на наявність обов'язкових полів
	if (!telegramId || !referrerNick) {
		return res.status(400).json({ message: 'Missing telegramId or referrerNick' });
	}

	const now = Math.floor(Date.now() / 1000);

	try {
		const conn = await pool.getConnection();

		try {
			await conn.beginTransaction();

			// Перевірка на існування користувача
			const [user] = await conn.query('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);

			if (user.length === 0) {
				await conn.rollback();
				conn.release();
				return res.status(404).json({ message: 'User not found' });
			}

			// Перевірка чи вже є реферал
			if (user[0].referrer_nick) {
				await conn.rollback();
				conn.release();
				return res.status(409).json({ message: 'User already has a referrer' });
			}

			// Перевірка на існування реферала з урахуванням регістру
			const [referrers] = await conn.query('SELECT * FROM users WHERE minecraft_nick = ?', [referrerNick]);

			// Перевіряємо точний збіг з урахуванням регістру
			const exactMatch = referrers.find(refUser => refUser.minecraft_nick === referrerNick);

			if (!exactMatch) {
				await conn.rollback();
				conn.release();
				return res.status(404).json({ message: 'Referrer not found' });
			}

			// Перевірка, що користувач не намагається вказати себе як реферала
			// Тут теж порівнюємо з урахуванням регістру
			if (user[0].minecraft_nick === referrerNick) {
				await conn.rollback();
				conn.release();
				return res.status(400).json({ message: 'Cannot set yourself as a referrer' });
			}

			const referrerTelegramId = exactMatch.telegram_id;

			// Оновлюємо інформацію про реферала в таблиці users
			// Використовуємо ім'я з точним регістром, яке знайшли в БД
			await conn.query(
				'UPDATE users SET referrer_nick = ?, updated_at = ? WHERE telegram_id = ?',
				[exactMatch.minecraft_nick, now, telegramId]
			);

			// Додаємо запис в таблицю referrals 
			await conn.query(
				'INSERT INTO referrals  (referrer_telegram_id, referred_telegram_id, referred_nick, confirmed, created_at) VALUES (?, ?, ?, ?, ?)',
				[referrerTelegramId, telegramId, user[0].minecraft_nick, 1, now]
			);

			// Оновлюємо кількість рефералів для реферера в таблиці discounts
			const [discountRecord] = await conn.query(
				'SELECT * FROM discounts WHERE telegram_id = ?',
				[referrerTelegramId]
			);

			if (discountRecord.length > 0) {
				// Якщо запис існує, збільшуємо лічильник
				await conn.query(
					'UPDATE discounts SET referrals_count = referrals_count + 1, updated_at = ? WHERE telegram_id = ?',
					[now, referrerTelegramId]
				);

				// Оновлюємо відсоток знижки: 2% за кожного реферала, максимум 40% (20 рефералів)
				await conn.query(
					'UPDATE discounts SET discount_percent = CASE ' +
					'WHEN referrals_count >= 20 THEN 40 ' +
					'ELSE referrals_count * 2 ' +
					'END, updated_at = ? WHERE telegram_id = ?',
					[now, referrerTelegramId]
				);
			} else {
				// Якщо запису нема, створюємо новий з знижкою 2% за першого реферала
				await conn.query(
					'INSERT INTO discounts (telegram_id, referrals_count, discount_percent, updated_at) VALUES (?, ?, ?, ?)',
					[referrerTelegramId, 1, 2, now]
				);
			}

			await conn.commit();
			conn.release();

			return res.status(200).json({
				message: 'Referrer added successfully',
				referrer_nick: exactMatch.minecraft_nick
			});

		} catch (error) {
			await conn.rollback();
			conn.release();
			throw error;
		}
	} catch (err) {
		console.error('Add referrer error:', err);
		return res.status(500).json({ message: 'Error adding referrer' });
	}
}

export { register, addReferrer };