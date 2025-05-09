import { createClient } from 'redis';
import 'dotenv/config';

// Підключення до Redis
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redisClient = createClient({
	url: redisUrl,
	socket: {
		reconnectStrategy: (retries) => {
			// Експоненціальна затримка при повторних спробах
			const delay = Math.min(retries * 50, 2000);
			return delay;
		}
	}
});

redisClient.on('error', (err) => {
	console.error('❌ Помилка Redis:', err);
});

redisClient.on('reconnecting', () => {
	console.log('ℹ️ Повторне підключення до Redis...');
});

redisClient.on('connect', () => {
	console.log('✅ Успішне підключення до Redis');
});

// Кешовані дані зареєстрованих користувачів
const CACHE_KEYS = {
	REGISTERED_USERS: 'registered_users',
	USER_DAILY_MESSAGES: 'daily_messages',  // Hash для всіх користувачів
	USER_LAST_MESSAGE: 'last_message',      // Hash для часу останнього повідомлення
	PENDING_UPDATES: 'pending_updates',     // Set для списку користувачів з оновленнями
};

// Максимальне значення TTL при помилці
const DEFAULT_TTL = 86400; // 24 години

/**
 * Підключення до Redis з повторними спробами
 */
const connectRedis = async (maxRetries = 5) => {
	let retries = 0;

	const tryConnect = async () => {
		try {
			await redisClient.connect();
			return true;
		} catch (error) {
			if (retries < maxRetries) {
				retries++;
				const delayMs = Math.pow(2, retries) * 1000; // Експоненціальний відступ
				console.log(`⏱️ Спроба ${retries}/${maxRetries} підключення до Redis через ${delayMs}ms`);
				await new Promise(resolve => setTimeout(resolve, delayMs));
				return tryConnect();
			} else {
				console.error('❌ Максимальна кількість спроб підключення до Redis вичерпана:', error);
				return false;
			}
		}
	};

	return tryConnect();
};

/**
 * Завантажує список зареєстрованих користувачів у кеш
 * @param {object} pool MySQL connection pool
 */
const loadRegisteredUsers = async (pool) => {
	try {
		const [users] = await pool.query('SELECT telegram_id FROM users');

		if (users.length > 0) {
			// Додаємо всіх користувачів до множини
			const telegramIds = users.map(user => user.telegram_id.toString());

			// Використовуємо pipeline для оптимізації
			const pipeline = redisClient.multi();

			// Спочатку видаляємо попередній список, якщо він є
			pipeline.del(CACHE_KEYS.REGISTERED_USERS);

			// Додаємо всіх користувачів до множини
			if (telegramIds.length > 0) {
				pipeline.sAdd(CACHE_KEYS.REGISTERED_USERS, telegramIds);
			}

			// Виконуємо всі команди разом
			await pipeline.exec();

			console.log(`✅ Кеш зареєстрованих користувачів оновлено: ${telegramIds.length} записів`);
		}
	} catch (error) {
		console.error('❌ Помилка завантаження зареєстрованих користувачів:', error);
	}
};

/**
 * Додає користувача до кешу зареєстрованих
 * @param {string} telegramId ID користувача
 */
const addRegisteredUser = async (telegramId) => {
	try {
		await redisClient.sAdd(CACHE_KEYS.REGISTERED_USERS, telegramId.toString());
	} catch (error) {
		console.error(`❌ Помилка додавання користувача ${telegramId} до кешу:`, error);
	}
};

/**
 * Перевіряє, чи зареєстрований користувач (без запиту до MySQL)
 * @param {string} telegramId ID користувача
 * @returns {Promise<boolean>} true, якщо користувач зареєстрований
 */
const isUserRegistered = async (telegramId) => {
	try {
		return await redisClient.sIsMember(CACHE_KEYS.REGISTERED_USERS, telegramId.toString());
	} catch (error) {
		console.error(`❌ Помилка перевірки реєстрації користувача ${telegramId}:`, error);
		return false;
	}
};

/**
 * Інкрементує лічильник повідомлень користувача
 * @param {string} telegramId ID користувача в Telegram
 * @returns {Promise<number|string>} Результат операції
 */
const incrementUserMessages = async (telegramId) => {
	try {
		const today = new Date().toISOString().split('T')[0];
		const key = `${telegramId}:${today}`;
		const now = Date.now();

		// Отримуємо час останнього повідомлення
		const lastMessage = await redisClient.hGet(CACHE_KEYS.USER_LAST_MESSAGE, telegramId);
		if (lastMessage && now - parseInt(lastMessage) < 5000) {
			return "COOLDOWN"; // Кулдаун активний
		}

		// Отримуємо поточну кількість повідомлень
		const count = await redisClient.hGet(CACHE_KEYS.USER_DAILY_MESSAGES, key);
		const currentCount = count ? parseInt(count) : 0;

		// Перевіряємо ліміт
		if (currentCount >= 200) {
			return "LIMIT_REACHED";
		}

		// Оновлюємо час останнього повідомлення
		await redisClient.hSet(CACHE_KEYS.USER_LAST_MESSAGE, telegramId, now.toString());

		// Збільшуємо лічильник
		const newCount = currentCount + 1;
		await redisClient.hSet(CACHE_KEYS.USER_DAILY_MESSAGES, key, newCount.toString());

		// Визначаємо час до кінця дня
		const midnight = new Date();
		midnight.setHours(23, 59, 59, 999);
		const expirySeconds = Math.floor((midnight.getTime() - now) / 1000);

		// Встановлюємо час життя для хешу
		await redisClient.expire(CACHE_KEYS.USER_DAILY_MESSAGES, expirySeconds);

		// Додаємо користувача до множини для оновлення
		await redisClient.sAdd(CACHE_KEYS.PENDING_UPDATES, telegramId.toString());

		return newCount;
	} catch (error) {
		console.error(`❌ Помилка збільшення лічильника повідомлень для ${telegramId}:`, error);
		return "ERROR";
	}
};

/**
 * Отримує всі щоденні лічильники повідомлень
 * @returns {Promise<Object>} Об'єкт з кількістю повідомлень для кожного користувача
 */
const getAllDailyMessageCounts = async () => {
	try {
		return await redisClient.hGetAll(CACHE_KEYS.USER_DAILY_MESSAGES);
	} catch (error) {
		console.error('❌ Помилка отримання щоденних лічильників повідомлень:', error);
		return {};
	}
};

/**
 * Отримує список користувачів, які очікують оновлення в базі даних
 * @returns {Promise<string[]>} Масив ID користувачів
 */
const getPendingUpdates = async () => {
	try {
		return await redisClient.sMembers(CACHE_KEYS.PENDING_UPDATES);
	} catch (error) {
		console.error('❌ Помилка отримання списку користувачів для оновлення:', error);
		return [];
	}
};

/**
 * Видаляє користувачів зі списку очікування після оновлення в базі даних
 * @param {string[]} telegramIds Масив ID користувачів
 */
const clearPendingUpdates = async (telegramIds) => {
	try {
		if (telegramIds.length > 0) {
			await redisClient.sRem(CACHE_KEYS.PENDING_UPDATES, ...telegramIds);
		}
	} catch (error) {
		console.error('❌ Помилка очищення списку користувачів для оновлення:', error);
	}
};

/**
 * Видаляє всі кеші після успішного оновлення
 * @param {string[]} processedKeys Ключі, які були оброблені
 */
const clearProcessedCounts = async (processedKeys) => {
	try {
		if (processedKeys.length > 0) {
			await redisClient.hDel(CACHE_KEYS.USER_DAILY_MESSAGES, ...processedKeys);
		}
	} catch (error) {
		console.error('❌ Помилка очищення оброблених лічильників:', error);
	}
};

export {
	redisClient,
	connectRedis,
	loadRegisteredUsers,
	addRegisteredUser,
	isUserRegistered,
	incrementUserMessages,
	getAllDailyMessageCounts,
	getPendingUpdates,
	clearPendingUpdates,
	clearProcessedCounts
};