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
	console.log('📨 Повторне підключення до Redis...');
});

redisClient.on('connect', () => {
	console.log('✅ Успішне підключення до Redis');
});

// Кешовані дані зареєстрованих користувачів
const CACHE_KEYS = {
	USER_PROCESSED_MESSAGES: 'processed_messages',      // Кількість вже оброблених повідомлень
	USER_PROCESSED_BALANCES: 'processed_balances',      // Кількість вже оброблених балансів
	REGISTERED_USERS: 'registered_users',               // Set для зареєстрованих користувачів
	USER_DAILY_MESSAGES: 'daily_messages',              // Hash для всіх користувачів і кількості повідомлень
	USER_LAST_MESSAGE: 'last_message',                  // Hash для часу останнього повідомлення
	USER_BALANCE: 'user_balance',                       // Hash для балансу повідомлень користувача
	PENDING_UPDATES: 'pending_updates',                 // Set для списку користувачів з оновленнями
	CURRENT_PERIOD_KEY: 'current_message_period',       // Ключ для визначення поточного періоду підрахунку
	PERIOD_START_TIME: 'period_start_time',             // Час початку поточного періоду (timestamp)
	PERIOD_END_TIME: 'period_end_time',                 // Час закінчення поточного періоду (timestamp)
};

// Кулдаун між повідомленнями (мс)
const MESSAGE_COOLDOWN = 5000; // 5 секунд

// Максимальна кількість повідомлень за період
const MAX_MESSAGES_PER_PERIOD = 200;

/**
 * Підключення до Redis з повторними спробами
 */
const connectRedis = async (maxRetries = 5) => {
	let retries = 0;

	const tryConnect = async () => {
		try {
			await redisClient.connect();
			// Ініціалізуємо або перевіряємо період повідомлень
			await initializeMessagePeriod();
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
 * Ініціалізує або перевіряє поточний період підрахунку повідомлень
 * Період: з 13:00 до 13:00 наступного дня за Київським часом
 */
const initializeMessagePeriod = async () => {
	try {
		// Отримуємо збережені дані про поточний період
		const periodStart = await redisClient.get(CACHE_KEYS.PERIOD_START_TIME);
		const periodEnd = await redisClient.get(CACHE_KEYS.PERIOD_END_TIME);

		const now = Date.now();

		// Якщо період не встановлений або закінчився
		if (!periodStart || !periodEnd || parseInt(periodEnd) < now) {
			return await setupNewMessagePeriod();
		} else {
			console.log(`✅ Поточний період повідомлень: ${new Date(parseInt(periodStart)).toLocaleString('uk-UA')} - ${new Date(parseInt(periodEnd)).toLocaleString('uk-UA')}`);
			return {
				start: parseInt(periodStart),
				end: parseInt(periodEnd)
			};
		}
	} catch (error) {
		console.error('❌ Помилка ініціалізації періоду повідомлень:', error);
		return null;
	}
};

/**
 * Налаштовує новий період підрахунку повідомлень
 * Період: з 13:00 до 13:00 наступного дня за Київським часом
 */
const setupNewMessagePeriod = async () => {
	try {
		// Отримуємо поточний час у мілісекундах
		const now = new Date();

		// Встановлюємо дату на 13:00 поточного дня (за Київським часом, UTC+2/UTC+3)
		const kyivNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kiev' }));
		const periodStartTime = new Date(kyivNow);
		periodStartTime.setHours(13, 0, 0, 0);

		// Якщо поточний час пізніше 13:00, початок періоду - сьогодні о 13:00
		// Якщо поточний час раніше 13:00, початок періоду - вчора о 13:00
		if (kyivNow.getHours() < 13) {
			periodStartTime.setDate(periodStartTime.getDate() - 1);
		}

		// Кінець періоду - через 24 години після початку
		const periodEndTime = new Date(periodStartTime);
		periodEndTime.setDate(periodStartTime.getDate() + 1);

		// Зберігаємо часові мітки в Redis
		const startTimestamp = periodStartTime.getTime();
		const endTimestamp = periodEndTime.getTime();

		await redisClient.set(CACHE_KEYS.PERIOD_START_TIME, startTimestamp.toString());
		await redisClient.set(CACHE_KEYS.PERIOD_END_TIME, endTimestamp.toString());

		// Встановлюємо унікальний ключ для поточного періоду
		const periodKey = `period:${startTimestamp}`;
		await redisClient.set(CACHE_KEYS.CURRENT_PERIOD_KEY, periodKey);

		console.log(`✅ Встановлено новий період повідомлень: ${periodStartTime.toLocaleString('uk-UA')} - ${periodEndTime.toLocaleString('uk-UA')}`);

		return {
			start: startTimestamp,
			end: endTimestamp,
			key: periodKey
		};
	} catch (error) {
		console.error('❌ Помилка налаштування нового періоду повідомлень:', error);
		return null;
	}
};

/**
 * Скидає поточний період і створює новий
 * Викликається при запуску планувальника нагород
 */
const resetMessagePeriod = async () => {
	try {
		// Спочатку отримуємо поточний ключ періоду (для можливого видалення даних)
		const currentPeriodKey = await redisClient.get(CACHE_KEYS.CURRENT_PERIOD_KEY);

		// Видаляємо всі ключі, пов'язані з поточним періодом
		if (currentPeriodKey) {
			// Очищаємо лічильники повідомлень (опціонально, якщо зберігаємо їх у спеціальному форматі)
			// await redisClient.del(`${currentPeriodKey}:messages`);
		}

		// Скидаємо дані про період
		await redisClient.del(CACHE_KEYS.PERIOD_START_TIME);
		await redisClient.del(CACHE_KEYS.PERIOD_END_TIME);
		await redisClient.del(CACHE_KEYS.CURRENT_PERIOD_KEY);

		// Скидаємо лічильники повідомлень
		await redisClient.del(CACHE_KEYS.USER_DAILY_MESSAGES);
		await redisClient.del(CACHE_KEYS.USER_PROCESSED_MESSAGES);
		await redisClient.del(CACHE_KEYS.USER_PROCESSED_BALANCES); // Додаємо скидання оброблених балансів
		await redisClient.del(CACHE_KEYS.USER_BALANCE);
		await redisClient.del(CACHE_KEYS.PENDING_UPDATES);

		// Встановлюємо новий період
		return await setupNewMessagePeriod();
	} catch (error) {
		console.error('❌ Помилка скидання періоду повідомлень:', error);
		return null;
	}
};

/**
 * Отримує загальну кількість повідомлень користувача за поточний період
 * @param {string} telegramId ID користувача в Telegram
 * @returns {Promise<number>} Кількість повідомлень
 */
const getUserMessageCount = async (telegramId) => {
	try {
		const count = await redisClient.hGet(CACHE_KEYS.USER_DAILY_MESSAGES, telegramId);
		return count ? parseInt(count) : 0;
	} catch (error) {
		console.error(`❌ Помилка отримання кількості повідомлень для ${telegramId}:`, error);
		return 0;
	}
};

/**
 * Отримує поточний баланс повідомлень користувача
 * @param {string} telegramId ID користувача в Telegram
 * @returns {Promise<number>} Баланс повідомлень
 */
const getUserBalance = async (telegramId) => {
	try {
		const balance = await redisClient.hGet(CACHE_KEYS.USER_BALANCE, telegramId);
		return balance ? parseInt(balance) : 0;
	} catch (error) {
		console.error(`❌ Помилка отримання балансу повідомлень для ${telegramId}:`, error);
		return 0;
	}
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
		const now = Date.now();

		// Перевіряємо чи активний поточний період
		await initializeMessagePeriod();

		// Отримуємо час останнього повідомлення
		const lastMessage = await redisClient.hGet(CACHE_KEYS.USER_LAST_MESSAGE, telegramId);

		if (lastMessage && now - parseInt(lastMessage) < MESSAGE_COOLDOWN) {
			return "COOLDOWN"; // Кулдаун активний
		}

		// Отримуємо поточну кількість повідомлень і баланс
		const count = await redisClient.hGet(CACHE_KEYS.USER_DAILY_MESSAGES, telegramId);
		const currentCount = count ? parseInt(count) : 0;

		// Отримуємо поточний баланс (або створюємо новий ключ)
		const balance = await redisClient.hGet(CACHE_KEYS.USER_BALANCE, telegramId);
		let currentBalance = balance ? parseInt(balance) : 0;

		// Збільшуємо лічильник загальної кількості повідомлень
		const newCount = currentCount + 1;
		await redisClient.hSet(CACHE_KEYS.USER_DAILY_MESSAGES, telegramId, newCount.toString());

		// Збільшуємо баланс, але обмежуємо його на рівні MAX_MESSAGES_PER_PERIOD
		currentBalance = Math.min(currentBalance + 1, MAX_MESSAGES_PER_PERIOD);
		await redisClient.hSet(CACHE_KEYS.USER_BALANCE, telegramId, currentBalance.toString());

		// Оновлюємо час останнього повідомлення
		await redisClient.hSet(CACHE_KEYS.USER_LAST_MESSAGE, telegramId, now.toString());

		// Отримуємо час кінця періоду
		const periodEnd = await redisClient.get(CACHE_KEYS.PERIOD_END_TIME);
		if (periodEnd) {
			// Визначаємо час до кінця періоду
			const expirySeconds = Math.floor((parseInt(periodEnd) - now) / 1000);
			if (expirySeconds > 0) {
				// Встановлюємо час життя для хешів
				await redisClient.expire(CACHE_KEYS.USER_DAILY_MESSAGES, expirySeconds);
				await redisClient.expire(CACHE_KEYS.USER_LAST_MESSAGE, expirySeconds);
				await redisClient.expire(CACHE_KEYS.USER_BALANCE, expirySeconds);
			}
		}

		// Додаємо користувача до множини для оновлення
		await redisClient.sAdd(CACHE_KEYS.PENDING_UPDATES, telegramId.toString());

		return {
			count: newCount,
			balance: currentBalance
		};
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
 * Отримує всі баланси повідомлень користувачів
 * @returns {Promise<Object>} Об'єкт з балансами повідомлень для кожного користувача
 */
const getAllUserBalances = async () => {
	try {
		return await redisClient.hGetAll(CACHE_KEYS.USER_BALANCE);
	} catch (error) {
		console.error('❌ Помилка отримання балансів повідомлень:', error);
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
 * Отримати топ користувачів за кількістю повідомлень
 * @param {number} limit Кількість користувачів
 * @returns {Promise<Array>} Масив [telegramId, count]
 */
const getTopMessageUsers = async (limit = 10) => {
	try {
		// Отримуємо всі лічильники
		const messageCountsObj = await getAllDailyMessageCounts();

		// Перетворюємо об'єкт на масив пар [telegramId, count]
		const messageCounts = Object.entries(messageCountsObj)
			.map(([telegramId, count]) => [telegramId, parseInt(count)])
			.sort((a, b) => b[1] - a[1]) // Сортуємо за спаданням
			.slice(0, limit); // Обмежуємо кількість

		return messageCounts;
	} catch (error) {
		console.error('❌ Помилка отримання топ користувачів за повідомленнями:', error);
		return [];
	}
};

/**
 * Скидає лічильники повідомлень для всіх користувачів
 */
const resetAllMessageCounts = async () => {
	try {
		await redisClient.del(CACHE_KEYS.USER_DAILY_MESSAGES);
		await redisClient.del(CACHE_KEYS.USER_PROCESSED_MESSAGES);
		await redisClient.del(CACHE_KEYS.USER_BALANCE);  // Скидаємо баланси
		await redisClient.del(CACHE_KEYS.PENDING_UPDATES);
		console.log('✅ Всі лічильники повідомлень скинуто');
		return true;
	} catch (error) {
		console.error('❌ Помилка скидання лічильників повідомлень:', error);
		return false;
	}
};

export {
	CACHE_KEYS,
	redisClient,
	connectRedis,
	loadRegisteredUsers,
	addRegisteredUser,
	isUserRegistered,
	incrementUserMessages,
	getAllDailyMessageCounts,
	getAllUserBalances,
	getPendingUpdates,
	clearPendingUpdates,
	getUserMessageCount,
	getTopMessageUsers,
	resetAllMessageCounts,
	resetMessagePeriod,
	getUserBalance,
	initializeMessagePeriod
};