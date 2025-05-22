import cron from 'node-cron';
import { pool } from './db.service.js';
import {
	getAllDailyMessageCounts,
	getAllUserBalances,
	getPendingUpdates,
	clearPendingUpdates,
	redisClient,
	CACHE_KEYS
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
 * @param {Object} balanceCounts Баланс повідомлень для кожного користувача
 * @returns {Promise<string[]>} Успішно оброблені ключі
 */
const processBatch = async (userBatch, messageCounts, balanceCounts) => {
	const conn = await pool.getConnection();
	const now = Math.floor(Date.now() / 1000);
	const processedKeys = [];

	try {
		await conn.beginTransaction();

		for (const telegramId of userBatch) {
			// Отримуємо поточну кількість повідомлень
			const messageCount = messageCounts[telegramId] ? parseInt(messageCounts[telegramId]) : 0;
			if (messageCount === 0) continue;

			// Отримуємо поточний баланс
			const balanceCount = balanceCounts[telegramId] ? parseInt(balanceCounts[telegramId]) : 0;

			// Отримуємо кількість вже оброблених повідомлень та балансів
			const processedMessageCount = await redisClient.hGet(CACHE_KEYS.USER_PROCESSED_MESSAGES, telegramId) || 0;
			const processedBalanceCount = await redisClient.hGet(CACHE_KEYS.USER_PROCESSED_BALANCES, telegramId) || 0;

			// Конвертуємо в числа
			const processedMessageCountNum = parseInt(processedMessageCount);
			const processedBalanceCountNum = parseInt(processedBalanceCount);

			// Розраховуємо нові повідомлення і баланс для додавання до бази
			const newMessages = messageCount - processedMessageCountNum;
			const newBalance = balanceCount - processedBalanceCountNum;

			// Виконуємо оновлення лише якщо є нові повідомлення або баланс
			if (newMessages > 0 || newBalance > 0) {
				await conn.query(
					'UPDATE users SET messages_count = messages_count + ?, game_balance = game_balance + ?, updated_at = ? WHERE telegram_id = ?',
					[newMessages, newBalance, now, telegramId]
				);

				// Оновлюємо лічильники оброблених даних у Redis
				await redisClient.hSet(CACHE_KEYS.USER_PROCESSED_MESSAGES, telegramId, messageCount.toString());
				await redisClient.hSet(CACHE_KEYS.USER_PROCESSED_BALANCES, telegramId, balanceCount.toString());

				console.log(`✅ Оновлено для користувача ${telegramId}: +${newMessages} повідомлень, +${newBalance} монет`);
			} else {
				console.log(`ℹ️ Для користувача ${telegramId} немає нових даних для оновлення (повідомлення: ${messageCount}/${processedMessageCountNum}, баланс: ${balanceCount}/${processedBalanceCountNum})`);
			}

			processedKeys.push(telegramId);
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
 * Оновлює кількість повідомлень та баланс гравців у базі даних на основі даних з Redis
 * @returns {Promise<number>} Кількість оновлених користувачів
 */
const updateUserBalances = async () => {
	console.log('🔄 Запуск оновлення даних користувачів...');

	try {
		// Отримуємо список користувачів для оновлення
		const pendingUsers = await getPendingUpdates();

		if (pendingUsers.length === 0) {
			console.log('📨 Немає користувачів для оновлення');
			return 0;
		}

		console.log(`📨 Знайдено ${pendingUsers.length} користувачів для оновлення`);

		// Отримуємо всі лічильники повідомлень та балансів
		const messageCounts = await getAllDailyMessageCounts();
		const balanceCounts = await getAllUserBalances();

		// Розбиваємо користувачів на пакети
		const batches = chunkArray(pendingUsers, BATCH_SIZE);

		let totalProcessed = 0;
		let allProcessedKeys = [];

		// Послідовно обробляємо кожен пакет
		for (const batch of batches) {
			const processedKeys = await processBatch(batch, messageCounts, balanceCounts);
			allProcessedKeys = [...allProcessedKeys, ...processedKeys];
			totalProcessed += processedKeys.length;

			// Невелика пауза між пакетами, щоб зменшити навантаження
			if (batches.length > 1) {
				await new Promise(resolve => setTimeout(resolve, 1000));
			}
		}

		// Очищаємо оброблені дані з множини очікування
		if (allProcessedKeys.length > 0) {
			await clearPendingUpdates(allProcessedKeys);
		}

		console.log(`✅ Успішно оновлено дані для ${totalProcessed} користувачів`);

		return totalProcessed;
	} catch (error) {
		console.error('❌ Помилка оновлення даних користувачів:', error);
		return 0;
	}
};

/**
 * Ініціалізує ключ для зберігання оброблених балансів у Redis,
 * якщо він ще не існує
 */
const initializeProcessedBalances = async () => {
	try {
		// Перевіряємо, чи існує ключ для оброблених балансів
		const exists = await redisClient.exists(CACHE_KEYS.USER_PROCESSED_BALANCES);

		if (!exists) {
			console.log('📨 Ініціалізація кешу оброблених балансів...');

			// Отримуємо час кінця періоду для встановлення TTL
			const periodEnd = await redisClient.get(CACHE_KEYS.PERIOD_END_TIME);

			if (periodEnd) {
				const now = Date.now();
				const expirySeconds = Math.floor((parseInt(periodEnd) - now) / 1000);

				if (expirySeconds > 0) {
					// Встановлюємо час життя для нового ключа
					await redisClient.expire(CACHE_KEYS.USER_PROCESSED_BALANCES, expirySeconds);
				}
			}
		}
	} catch (error) {
		console.error('❌ Помилка ініціалізації кешу оброблених балансів:', error);
	}
};

/**
 * Запускає періодичне оновлення даних гравців за розкладом cron
 */
const startPeriodicUpdates = async () => {
	console.log('⏱️ Налаштування періодичного оновлення даних користувачів за розкладом cron');

	// Ініціалізуємо ключ для оброблених балансів
	await initializeProcessedBalances();

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