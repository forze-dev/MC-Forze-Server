import { pool } from './db.service.js';

/**
 * Оновлює знижки для реферера
 * @param {Object} conn - Підключення до бази даних
 * @param {string} referrerTelegramId - Telegram ID реферера
 * @param {number} now - Поточний час у форматі UNIX timestamp
 */
async function updateReferrerDiscounts(conn, referrerTelegramId, now) {
	try {
		// Перевіряємо чи є запис для цього користувача в таблиці знижок
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

		console.log(`✅ Знижки оновлено для користувача ${referrerTelegramId}`);
		return true;
	} catch (error) {
		console.error('❌ Помилка при оновленні знижок:', error);
		return false;
	}
}

/**
 * Додає запис про реферала
 * @param {Object} conn - Підключення до бази даних
 * @param {string} referrerTelegramId - Telegram ID реферера 
 * @param {string} referredTelegramId - Telegram ID запрошеного користувача
 * @param {string} referredNick - Нік запрошеного користувача
 * @param {number} now - Поточний час у форматі UNIX timestamp
 */
async function addReferralRecord(conn, referrerTelegramId, referredTelegramId, referredNick, now) {
	try {
		// Додаємо запис в таблицю referrals
		await conn.query(
			'INSERT INTO referrals (referrer_telegram_id, referred_telegram_id, referred_nick, confirmed, created_at) VALUES (?, ?, ?, ?, ?)',
			[referrerTelegramId, referredTelegramId, referredNick, 1, now]
		);

		console.log(`✅ Додано запис про реферала: ${referredNick}`);
		return true;
	} catch (error) {
		console.error('❌ Помилка при додаванні запису про реферала:', error);
		return false;
	}
}

export { updateReferrerDiscounts, addReferralRecord };