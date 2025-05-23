import { pool } from '../services/db.service.js';
import rconService from '../services/rcon.service.js';
import cron from 'node-cron';

class ShopService {
	constructor() {
		this.processing = false;
		this.maxRetries = 3;
		this.retryDelay = 5000; // 5 секунд
	}

	/**
	 * Головний метод обробки покупки товару
	 * @param {Object} purchaseData - Дані про покупку
	 * @param {string} purchaseData.telegramId - Telegram ID покупця
	 * @param {number} purchaseData.productId - ID товару
	 * @param {string} purchaseData.minecraftNick - Minecraft нікнейм
	 * @param {number} purchaseData.quantity - Кількість
	 * @param {number} purchaseData.purchaseId - ID покупки з таблиці purchases
	 * @returns {Promise<Object>} Результат обробки
	 */
	async processPurchase(purchaseData) {
		const { telegramId, productId, minecraftNick, quantity = 1, purchaseId } = purchaseData;

		if (!purchaseId) {
			throw new Error('Purchase ID є обов\'язковим параметром');
		}

		console.log(`🔄 Обробка покупки для ${minecraftNick} (Purchase ID: ${purchaseId}, Product ID: ${productId})`);

		try {
			const conn = await pool.getConnection();

			try {
				await conn.beginTransaction();

				// Отримуємо інформацію про товар
				const [products] = await conn.query(
					'SELECT * FROM products WHERE id = ? AND is_active = 1',
					[productId]
				);

				if (products.length === 0) {
					throw new Error('Товар не знайдено або неактивний');
				}

				const product = products[0];

				// Парсимо execution_config якщо він є
				if (product.execution_config && typeof product.execution_config === 'string') {
					try {
						product.execution_config = JSON.parse(product.execution_config);
					} catch (e) {
						console.error('❌ Помилка парсингу execution_config:', e);
						product.execution_config = {};
					}
				} else if (!product.execution_config) {
					product.execution_config = {};
				}

				let result = {};

				// Обробляємо залежно від типу товару
				switch (product.product_type) {
					case 'whitelist':
						result = await this._processWhitelistPurchase(conn, product, purchaseData);
						break;

					case 'item':
						// TODO: Буде реалізовано пізніше
						throw new Error('Тип товару "item" поки не підтримується');

					case 'subscription':
						// TODO: Буде реалізовано пізніше
						throw new Error('Тип товару "subscription" поки не підтримується');

					case 'rank':
						// TODO: Буде реалізовано пізніше
						throw new Error('Тип товару "rank" поки не підтримується');

					case 'service':
						// TODO: Буде реалізовано пізніше
						throw new Error('Тип товару "service" поки не підтримується');

					case 'command':
						// TODO: Буде реалізовано пізніше
						throw new Error('Тип товару "command" поки не підтримується');

					default:
						throw new Error(`Невідомий тип товару: ${product.product_type}`);
				}

				await conn.commit();
				return { success: true, productType: product.product_type, ...result };

			} catch (error) {
				await conn.rollback();
				throw error;
			} finally {
				conn.release();
			}

		} catch (error) {
			console.error('❌ Помилка обробки покупки:', error);
			return {
				success: false,
				error: error.message
			};
		}
	}

	/**
	 * Приватний метод обробки покупки вайтліста
	 * @param {Object} conn - З'єднання з базою даних
	 * @param {Object} product - Інформація про товар
	 * @param {Object} purchaseData - Дані про покупку
	 * @returns {Promise<Object>} Результат обробки
	 */
	async _processWhitelistPurchase(conn, product, purchaseData) {
		const { telegramId, minecraftNick, purchaseId } = purchaseData;

		console.log(`🎯 Обробка вайтліста для ${minecraftNick}`);

		// Створюємо запис виконання
		const now = Math.floor(Date.now() / 1000);
		const [executionResult] = await conn.query(
			`INSERT INTO product_executions 
			 (purchase_id, telegram_id, product_id, execution_type, execution_status, created_at) 
			 VALUES (?, ?, ?, 'whitelist_add', 'pending', ?)`,
			[purchaseId, telegramId, product.id, now]
		);

		const executionId = executionResult.insertId;

		// Перевіряємо чи потрібно автоматично виконувати
		if (product.auto_execute && !product.requires_manual_approval) {
			console.log(`🚀 Автоматичне додавання ${minecraftNick} до вайтліста`);

			const executionResult = await this._executeWhitelistCommand(
				product.execution_config,
				minecraftNick,
				conn,
				executionId
			);

			return {
				message: 'Тебе автоматично додано до вайтліста!',
				executionResults: executionResult.executionResults,
				autoExecuted: true
			};
		} else {
			// Потрібна ручна обробка
			await conn.query(
				'UPDATE product_executions SET execution_status = ? WHERE id = ?',
				['manual_required', executionId]
			);

			return {
				message: product.requires_manual_approval
					? 'Запит на додавання до вайтліста відправлено. Адміністратор розгляне його найближчим часом.'
					: 'Запит на додавання до вайтліста створено.',
				requiresManualAction: true,
				autoExecuted: false
			};
		}
	}

	/**
	 * Приватний метод виконання команди додавання до вайтліста
	 * @param {Object} executionConfig - Конфігурація виконання
	 * @param {string} minecraftNick - Minecraft нікнейм
	 * @param {Object} conn - З'єднання з базою даних
	 * @param {number} executionId - ID запису виконання
	 * @returns {Promise<Object>} Результат виконання
	 */
	async _executeWhitelistCommand(executionConfig, minecraftNick, conn, executionId) {
		try {
			const serverId = executionConfig.server_id || 'MFS';

			// Команда для додавання до вайтліста (стандартна команда Minecraft)
			let command = `whitelist add ${minecraftNick}`;

			// Якщо в конфігурації є кастомна команда, використовуємо її
			if (executionConfig.rcon_commands && Array.isArray(executionConfig.rcon_commands)) {
				command = this._replacePlaceholders(executionConfig.rcon_commands[0], {
					minecraft_nick: minecraftNick
				});
			} else if (executionConfig.whitelist_command) {
				command = this._replacePlaceholders(executionConfig.whitelist_command, {
					minecraft_nick: minecraftNick
				});
			}

			console.log(`🎯 Виконання команди додавання до вайтліста: ${command}`);

			// Виконуємо команду через RCON
			const result = await rconService.executeCommand(serverId, command);

			const executionResults = [{
				command: command,
				success: result.success,
				response: result.response || result.error
			}];

			const now = Math.floor(Date.now() / 1000);

			if (result.success) {
				// Успішне виконання
				await conn.query(
					'UPDATE product_executions SET execution_status = ?, execution_result = ?, command_executed = ?, executed_at = ? WHERE id = ?',
					['success', JSON.stringify(executionResults), command, now, executionId]
				);

				console.log(`✅ Гравця ${minecraftNick} успішно додано до вайтліста`);

				return {
					success: true,
					message: 'Тебе успішно додано до вайтліста сервера!',
					executionResults: executionResults
				};
			} else {
				// Помилка виконання
				await conn.query(
					'UPDATE product_executions SET execution_status = ?, execution_result = ?, command_executed = ?, retry_count = retry_count + 1 WHERE id = ?',
					['failed', result.error, command, executionId]
				);

				throw new Error(`Помилка додавання до вайтліста: ${result.error}`);
			}

		} catch (error) {
			console.error('❌ Помилка виконання команди вайтліста:', error);

			// Оновлюємо статус помилки
			const now = Math.floor(Date.now() / 1000);
			await conn.query(
				'UPDATE product_executions SET execution_status = ?, execution_result = ?, retry_count = retry_count + 1 WHERE id = ?',
				['failed', error.message, executionId]
			);

			throw error;
		}
	}

	/**
	 * Приватний метод заміни плейсхолдерів у командах
	 * @param {string} command - Команда з плейсхолдерами
	 * @param {Object} data - Дані для заміни
	 * @returns {string} Оброблена команда
	 */
	_replacePlaceholders(command, data) {
		let result = command;

		Object.keys(data).forEach(key => {
			const placeholder = `{${key}}`;
			result = result.replace(new RegExp(placeholder, 'g'), data[key]);
		});

		return result;
	}

	/**
	 * Обробка невиконаних команд
	 * Запускається за розкладом для повторної спроби невдалих виконань
	 */
	async processPendingExecutions() {
		if (this.processing) return;

		this.processing = true;
		console.log('🔄 Обробка невиконаних команд...');

		try {
			const conn = await pool.getConnection();

			try {
				// Отримуємо невиконані записи
				const [executions] = await conn.query(`
					SELECT pe.*, p.name as product_name, p.product_type, p.execution_config, u.minecraft_nick
					FROM product_executions pe
					JOIN products p ON pe.product_id = p.id
					JOIN users u ON pe.telegram_id = u.telegram_id
					WHERE pe.execution_status = 'pending' 
					AND pe.retry_count < pe.max_retries
					ORDER BY pe.created_at ASC
					LIMIT 10
				`);

				for (const execution of executions) {
					await this._retryExecution(conn, execution);
				}

			} finally {
				conn.release();
			}

		} catch (error) {
			console.error('❌ Помилка обробки невиконаних команд:', error);
		} finally {
			this.processing = false;
		}
	}

	/**
	 * Приватний метод повторної спроби виконання команди
	 * @param {Object} conn - З'єднання з базою даних
	 * @param {Object} execution - Запис виконання
	 */
	async _retryExecution(conn, execution) {
		try {
			console.log(`🔄 Повторна спроба виконання ${execution.execution_type} для ${execution.minecraft_nick}`);

			// Обробляємо залежно від типу виконання
			switch (execution.execution_type) {
				case 'whitelist_add':
					await this._retryWhitelistExecution(conn, execution);
					break;

				// Тут будуть інші типи в майбутньому
				default:
					console.log(`⚠️ Невідомий тип виконання: ${execution.execution_type}`);
			}

		} catch (error) {
			console.error(`❌ Помилка повторної спроби для ${execution.minecraft_nick}:`, error);
		}
	}

	/**
	 * Приватний метод повторної спроби виконання команди вайтліста
	 * @param {Object} conn - З'єднання з базою даних
	 * @param {Object} execution - Запис виконання
	 */
	async _retryWhitelistExecution(conn, execution) {
		try {
			let executionConfig = {};
			try {
				executionConfig = typeof execution.execution_config === 'string'
					? JSON.parse(execution.execution_config)
					: execution.execution_config || {};
			} catch (e) {
				throw new Error('Некоректна конфігурація команд');
			}

			const serverId = executionConfig.server_id || 'MFS';

			let command = `whitelist add ${execution.minecraft_nick}`;

			// Якщо в конфігурації є кастомна команда
			if (executionConfig.rcon_commands && Array.isArray(executionConfig.rcon_commands)) {
				command = this._replacePlaceholders(executionConfig.rcon_commands[0], {
					minecraft_nick: execution.minecraft_nick
				});
			} else if (executionConfig.whitelist_command) {
				command = this._replacePlaceholders(executionConfig.whitelist_command, {
					minecraft_nick: execution.minecraft_nick
				});
			}

			console.log(`🎯 Повторна команда вайтліста: ${command}`);

			const result = await rconService.executeCommand(serverId, command);
			const executionResults = [{
				command: command,
				success: result.success,
				response: result.response || result.error
			}];

			const now = Math.floor(Date.now() / 1000);

			if (result.success) {
				// Успішне виконання
				await conn.query(
					'UPDATE product_executions SET execution_status = ?, execution_result = ?, command_executed = ?, executed_at = ? WHERE id = ?',
					['success', JSON.stringify(executionResults), command, now, execution.id]
				);

				console.log(`✅ Повторна спроба успішна: гравця ${execution.minecraft_nick} додано до вайтліста`);
			} else {
				throw new Error(`Помилка команди: ${result.error}`);
			}

		} catch (error) {
			// Збільшуємо лічильник спроб
			const newRetryCount = execution.retry_count + 1;
			const status = newRetryCount >= execution.max_retries ? 'failed' : 'pending';

			await conn.query(
				'UPDATE product_executions SET retry_count = ?, execution_status = ?, execution_result = ? WHERE id = ?',
				[newRetryCount, status, error.message, execution.id]
			);

			console.log(`❌ Спроба ${newRetryCount}/${execution.max_retries} для вайтліста ${execution.minecraft_nick}: ${error.message}`);
		}
	}

	/**
	 * Запуск періодичних завдань
	 */
	startScheduledTasks() {
		// Обробка невиконаних команд кожні 2 хвилини
		cron.schedule('*/2 * * * *', () => {
			this.processPendingExecutions();
		});

		console.log('✅ Планувальник завдань магазину запущено');
	}

	/**
	 * Отримання статистики виконань
	 * @param {string} executionType - Тип виконання (опціонально)
	 * @returns {Promise<Object>} Статистика
	 */
	async getExecutionStats(executionType = null) {
		try {
			const conn = await pool.getConnection();

			try {
				let query = `
					SELECT 
						execution_type,
						execution_status,
						COUNT(*) as count
					FROM product_executions 
				`;

				const params = [];

				if (executionType) {
					query += ' WHERE execution_type = ?';
					params.push(executionType);
				}

				query += ' GROUP BY execution_type, execution_status';

				const [stats] = await conn.query(query, params);

				// Групуємо статистику за типом виконання
				const result = {};
				stats.forEach(stat => {
					if (!result[stat.execution_type]) {
						result[stat.execution_type] = {};
					}
					result[stat.execution_type][stat.execution_status] = stat.count;
				});

				return result;

			} finally {
				conn.release();
			}

		} catch (error) {
			console.error('❌ Помилка отримання статистики:', error);
			return {};
		}
	}
}

export default new ShopService();