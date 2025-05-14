import cron from 'node-cron';
import { pool } from './db.service.js';
import {
	getAllDailyMessageCounts,
	getPendingUpdates,
	clearPendingUpdates
} from './redis.service.js';

const BATCH_SIZE = 50; // Розмір пакету для обробки користувачів

/**
 * Розбиває масив на менші частини
 * @param {Array} array Масив для розбиття
 * @param {number} size Розмір пакету
 * @returns {Array<Array>} Масив пакетів
 */
const chunkArray = (array, size) => {
	const chunks = [];
	for (let i = 0; i < array.length; i += size) {
		chunks.push(array.slice(i, i + size));
	}
	return chunks;
};

/**
 * Обробляє один пакет користувачів
 * @param {string[]} userBatch ID користувачів для оновлення
 * @param {Object} messageCounts Кількість повідомлень для кожного користувача
 * @returns {Promise<string[]>} Успішно оброблені ключі
 */
const processBatch = async (userBatch, messageCounts) => {
	const conn = await pool.getConnection();
	const now = Math.floor(Date.now() / 1000);
	const processedKeys = [];

	try {
		await conn.beginTransaction();

		for (const telegramId of userBatch) {
			// Знаходимо всі ключі для цього користувача
			const today = new Date().toISOString().split('T')[0];
			const key = `${telegramId}:${today}`;

			const count = messageCounts[key];
			if (!count) continue;

			const messageCount = parseInt(count);

			// Оновлюємо користувача в базі даних
			await conn.query(
				'UPDATE users SET messages_count = messages_count + ?, game_balance = game_balance + ?, updated_at = ? WHERE telegram_id = ?',
				[messageCount, messageCount, now, telegramId]
			);

			processedKeys.push(key);
			console.log(`✅ Оновлено баланс для користувача ${telegramId}: +${messageCount} монет`);
		}

		await conn.commit();
		return processedKeys;
	} catch (error) {
		await conn.rollback();
		console.error('❌ Помилка обробки пакету користувачів:', error);
		return [];
	} finally {
		conn.release();
	}
};

/**
 * Оновлює баланс гравців у базі даних на основі даних з Redis
 * @returns {Promise<number>} Кількість оновлених користувачів
 */
const updateUserBalances = async () => {
	console.log('🔄 Запуск оновлення балансу гравців...');

	try {
		// Отримуємо список користувачів для оновлення
		const pendingUsers = await getPendingUpdates();

		if (pendingUsers.length === 0) {
			console.log('📨 Немає користувачів для оновлення');
			return 0;
		}

		console.log(`📨 Знайдено ${pendingUsers.length} користувачів для оновлення балансу`);

		// Отримуємо всі лічильники повідомлень
		const messageCounts = await getAllDailyMessageCounts();

		// Розбиваємо користувачів на пакети
		const batches = chunkArray(pendingUsers, BATCH_SIZE);

		let totalProcessed = 0;
		let allProcessedKeys = [];

		// Послідовно обробляємо кожен пакет
		for (const batch of batches) {
			const processedKeys = await processBatch(batch, messageCounts);
			allProcessedKeys = [...allProcessedKeys, ...processedKeys];
			totalProcessed += batch.length;

			// Невелика пауза між пакетами, щоб зменшити навантаження
			if (batches.length > 1) {
				await new Promise(resolve => setTimeout(resolve, 1000));
			}
		}

		// Очищаємо оброблені дані
		if (pendingUsers.length > 0) {
			await clearPendingUpdates(pendingUsers);
		}

		if (allProcessedKeys.length > 0) {
			// Лічильники повідомлень не очищаються тут
			// Будуть очищені під час щоденного скидання через sheduleRewards.service.js
			console.log(`💾 Залишено ${allProcessedKeys.length} лічильників повідомлень для щоденного звіту`);
		}

		console.log(`✅ Успішно оновлено баланс для ${totalProcessed} користувачів`);

		return totalProcessed;
	} catch (error) {
		console.error('❌ Помилка оновлення балансу гравців:', error);
		return 0;
	}
};

/**
 * Запускає періодичне оновлення балансу гравців за розкладом cron
 */
const startPeriodicUpdates = () => {
	console.log('⏱️ Налаштування періодичного оновлення балансу за розкладом cron');

	// Запускаємо оновлення кожні 5 хвилин
	cron.schedule('*/5 * * * *', async () => {
		try {
			await updateUserBalances();
		} catch (error) {
			console.error('❌ Помилка виконання планового оновлення:', error);
		}
	});

	// Запускаємо перше оновлення через 1 хвилину після запуску
	setTimeout(updateUserBalances, 60 * 1000);
};

export {
	updateUserBalances,
	startPeriodicUpdates
};