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
	 * Обробка покупки товару
	 * @param {Object} purchaseData - Дані про покупку
	 * @returns {Promise<Object>} Результат обробки
	 */
	async processPurchase(purchaseData) {
		const { telegramId, productId, minecraftNick, quantity = 1, purchaseId } = purchaseData;

		if (!purchaseId) {
			throw new Error('Purchase ID є обов\'язковим параметром');
		}

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
						product.execution_config = null;
					}
				}

				let result = {};

				// Обробляємо залежно від типу товару
				switch (product.product_type) {
					case 'item':
						result = await this.processItemPurchase(conn, product, purchaseData);
						break;
					case 'subscription':
						result = await this.processSubscriptionPurchase(conn, product, purchaseData);
						break;
					case 'whitelist':
						result = await this.processWhitelistPurchase(conn, product, purchaseData);
						break;
					case 'rank':
						result = await this.processRankPurchase(conn, product, purchaseData);
						break;
					case 'service':
						result = await this.processServicePurchase(conn, product, purchaseData);
						break;
					case 'command':
						result = await this.processCommandPurchase(conn, product, purchaseData);
						break;
					default:
						throw new Error(`Невідомий тип товару: ${product.product_type}`);
				}

				await conn.commit();
				return { success: true, ...result };

			} catch (error) {
				await conn.rollback();
				throw error;
			} finally {
				conn.release();
			}

		} catch (error) {
			console.error('❌ Помилка обробки покупки:', error);
			return { success: false, error: error.message };
		}
	}

	/**
	 * Обробка покупки предмету
	 */
	async processItemPurchase(conn, product, purchaseData) {
		const { telegramId, minecraftNick, quantity = 1, purchaseId } = purchaseData;

		if (product.auto_execute) {
			return await this.executeProductCommands(conn, product, purchaseData);
		} else {
			// Створюємо запис для ручного виконання
			await this.createExecutionRecord(conn, {
				purchaseId,
				telegramId,
				productId: product.id,
				executionType: 'item_give',
				status: 'manual_required'
			});

			return {
				message: 'Товар буде видано адміністратором вручну',
				requiresManualAction: true
			};
		}
	}

	/**
	 * Обробка покупки підписки
	 */
	async processSubscriptionPurchase(conn, product, purchaseData) {
		const { telegramId, minecraftNick, purchaseId } = purchaseData;
		const now = Math.floor(Date.now() / 1000);
		const endDate = now + (product.subscription_duration * 24 * 60 * 60);

		// Створюємо запис підписки
		await conn.query(
			`INSERT INTO subscriptions 
             (telegram_id, product_id, minecraft_nick, start_date, end_date, is_active, created_at) 
             VALUES (?, ?, ?, ?, ?, 1, ?)`,
			[telegramId, product.id, minecraftNick, now, endDate, now]
		);

		// Виконуємо команди активації
		if (product.auto_execute) {
			return await this.executeProductCommands(conn, product, purchaseData);
		}

		return {
			message: 'Підписка активована',
			subscriptionEnd: endDate
		};
	}

	/**
	 * Обробка додавання в вайтліст
	 */
	async processWhitelistPurchase(conn, product, purchaseData) {
		if (product.auto_execute) {
			return await this.executeProductCommands(conn, product, purchaseData);
		}

		const { purchaseId, telegramId } = purchaseData;
		await this.createExecutionRecord(conn, {
			purchaseId,
			telegramId,
			productId: product.id,
			executionType: 'whitelist_add',
			status: 'manual_required'
		});

		return {
			message: 'Запит на додавання в вайтліст створено',
			requiresManualAction: true
		};
	}

	/**
	 * Обробка присвоєння рангу
	 */
	async processRankPurchase(conn, product, purchaseData) {
		if (product.auto_execute) {
			return await this.executeProductCommands(conn, product, purchaseData);
		}

		const { purchaseId, telegramId } = purchaseData;
		await this.createExecutionRecord(conn, {
			purchaseId,
			telegramId,
			productId: product.id,
			executionType: 'rank_set',
			status: 'manual_required'
		});

		return {
			message: 'Запит на присвоєння рангу створено',
			requiresManualAction: true
		};
	}

	/**
	 * Обробка сервісних товарів
	 */
	async processServicePurchase(conn, product, purchaseData) {
		const { purchaseId, telegramId } = purchaseData;

		// Сервісні товари зазвичай потребують ручної обробки
		await this.createExecutionRecord(conn, {
			purchaseId,
			telegramId,
			productId: product.id,
			executionType: 'service_activate',
			status: 'manual_required'
		});

		return {
			message: 'Запит на сервіс створено. Адміністратор зв\'яжеться з вами',
			requiresManualAction: true
		};
	}

	/**
	 * Обробка кастомних команд
	 */
	async processCommandPurchase(conn, product, purchaseData) {
		if (product.auto_execute && !product.requires_manual_approval) {
			return await this.executeProductCommands(conn, product, purchaseData);
		}

		const { purchaseId, telegramId } = purchaseData;
		await this.createExecutionRecord(conn, {
			purchaseId,
			telegramId,
			productId: product.id,
			executionType: 'rcon_command',
			status: product.requires_manual_approval ? 'manual_required' : 'pending'
		});

		return {
			message: product.requires_manual_approval
				? 'Команда буде виконана після перевірки адміністратором'
				: 'Команда додана в чергу на виконання',
			requiresManualAction: product.requires_manual_approval
		};
	}

	/**
	 * Виконання команд товару через RCON
	 */
	async executeProductCommands(conn, product, purchaseData) {
		const { telegramId, minecraftNick, quantity = 1, purchaseId } = purchaseData;
		const config = product.execution_config;

		if (!config || !config.rcon_commands) {
			throw new Error('Конфігурація команд відсутня');
		}

		const serverId = config.server_id || 'MFS';
		const commands = Array.isArray(config.rcon_commands) ? config.rcon_commands : [config.rcon_commands];
		const results = [];

		// Створюємо запис виконання
		const executionId = await this.createExecutionRecord(conn, {
			purchaseId,
			telegramId,
			productId: product.id,
			executionType: 'rcon_command',
			status: 'pending'
		});

		try {
			for (let command of commands) {
				// Замінюємо плейсхолдери
				const processedCommand = this.replacePlaceholders(command, {
					minecraft_nick: minecraftNick,
					quantity: quantity,
					item_id: product.item_id || 'minecraft:diamond'
				});

				console.log(`🎯 Виконання команди для товару ${product.name}: ${processedCommand}`);

				const result = await rconService.executeCommand(serverId, processedCommand);
				results.push({
					command: processedCommand,
					success: result.success,
					response: result.response || result.error
				});

				if (!result.success) {
					throw new Error(`Помилка виконання команди: ${result.error}`);
				}

				// Невелика затримка між командами для уникнення спаму
				if (commands.length > 1) {
					await new Promise(resolve => setTimeout(resolve, 500));
				}
			}

			// Оновлюємо статус виконання
			await conn.query(
				'UPDATE product_executions SET execution_status = ?, execution_result = ?, executed_at = ? WHERE id = ?',
				['success', JSON.stringify(results), Math.floor(Date.now() / 1000), executionId]
			);

			return {
				message: 'Товар успішно видано',
				executionResults: results
			};

		} catch (error) {
			// Оновлюємо статус помилки
			await conn.query(
				'UPDATE product_executions SET execution_status = ?, execution_result = ?, retry_count = retry_count + 1 WHERE id = ?',
				['failed', error.message, executionId]
			);

			throw error;
		}
	}

	/**
	 * Створення запису про виконання
	 */
	async createExecutionRecord(conn, data) {
		const { purchaseId, telegramId, productId, executionType, status = 'pending' } = data;
		const now = Math.floor(Date.now() / 1000);

		const [result] = await conn.query(
			`INSERT INTO product_executions 
             (purchase_id, telegram_id, product_id, execution_type, execution_status, created_at) 
             VALUES (?, ?, ?, ?, ?, ?)`,
			[purchaseId, telegramId, productId, executionType, status, now]
		);

		return result.insertId;
	}

	/**
	 * Заміна плейсхолдерів у командах
	 */
	replacePlaceholders(command, data) {
		let result = command;

		Object.keys(data).forEach(key => {
			const placeholder = `{${key}}`;
			result = result.replace(new RegExp(placeholder, 'g'), data[key]);
		});

		return result;
	}

	/**
	 * Обробка невиконаних команд
	 */
	async processPendingExecutions() {
		if (this.processing) return;

		this.processing = true;
		console.log('🔄 Обробка невиконаних команд товарів...');

		try {
			const conn = await pool.getConnection();

			try {
				// Отримуємо невиконані записи
				const [executions] = await conn.query(`
                    SELECT pe.*, p.name as product_name, p.execution_config, u.minecraft_nick
                    FROM product_executions pe
                    JOIN products p ON pe.product_id = p.id
                    JOIN users u ON pe.telegram_id = u.telegram_id
                    WHERE pe.execution_status = 'pending' 
                    AND pe.retry_count < pe.max_retries
                    ORDER BY pe.created_at ASC
                    LIMIT 10
                `);

				for (const execution of executions) {
					await this.retryExecution(conn, execution);
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
	 * Повторна спроба виконання команди
	 */
	async retryExecution(conn, execution) {
		try {
			let config;
			try {
				config = typeof execution.execution_config === 'string'
					? JSON.parse(execution.execution_config)
					: execution.execution_config;
			} catch (e) {
				throw new Error('Некоректна конфігурація команд');
			}

			const serverId = config.server_id || 'MFS';

			if (!config.rcon_commands) {
				throw new Error('Команди відсутні');
			}

			const commands = Array.isArray(config.rcon_commands) ? config.rcon_commands : [config.rcon_commands];
			const results = [];

			for (let command of commands) {
				const processedCommand = this.replacePlaceholders(command, {
					minecraft_nick: execution.minecraft_nick,
					quantity: 1, // можна зберігати в execution_data
					item_id: 'minecraft:diamond' // теж можна зберігати
				});

				const result = await rconService.executeCommand(serverId, processedCommand);
				results.push({
					command: processedCommand,
					success: result.success,
					response: result.response || result.error
				});

				if (!result.success) {
					throw new Error(`Помилка команди: ${result.error}`);
				}

				// Затримка між командами
				if (commands.length > 1) {
					await new Promise(resolve => setTimeout(resolve, 500));
				}
			}

			// Успішне виконання
			await conn.query(
				'UPDATE product_executions SET execution_status = ?, execution_result = ?, executed_at = ? WHERE id = ?',
				['success', JSON.stringify(results), Math.floor(Date.now() / 1000), execution.id]
			);

			console.log(`✅ Успішно виконано команди для товару ${execution.product_name}`);

		} catch (error) {
			// Збільшуємо лічильник спроб
			const newRetryCount = execution.retry_count + 1;
			const status = newRetryCount >= execution.max_retries ? 'failed' : 'pending';

			await conn.query(
				'UPDATE product_executions SET retry_count = ?, execution_status = ?, execution_result = ? WHERE id = ?',
				[newRetryCount, status, error.message, execution.id]
			);

			console.log(`❌ Спроба ${newRetryCount}/${execution.max_retries} для товару ${execution.product_name}: ${error.message}`);
		}
	}

	/**
	 * Перевірка та обробка закінчених підписок
	 */
	async processExpiredSubscriptions() {
		console.log('🔄 Перевірка закінчених підписок...');

		try {
			const conn = await pool.getConnection();
			const now = Math.floor(Date.now() / 1000);

			try {
				// Знаходимо закінчені підписки
				const [expiredSubs] = await conn.query(`
                    SELECT s.*, p.execution_config, u.minecraft_nick
                    FROM subscriptions s
                    JOIN products p ON s.product_id = p.id
                    JOIN users u ON s.telegram_id = u.telegram_id
                    WHERE s.is_active = 1 AND s.end_date <= ?
                `, [now]);

				for (const subscription of expiredSubs) {
					await this.processExpiredSubscription(conn, subscription);
				}

			} finally {
				conn.release();
			}

		} catch (error) {
			console.error('❌ Помилка обробки закінчених підписок:', error);
		}
	}

	/**
	 * Обробка окремої закінченої підписки
	 */
	async processExpiredSubscription(conn, subscription) {
		try {
			let config;
			try {
				config = typeof subscription.execution_config === 'string'
					? JSON.parse(subscription.execution_config)
					: subscription.execution_config;
			} catch (e) {
				console.error(`❌ Некоректна конфігурація для підписки ${subscription.id}:`, e);
				config = {};
			}

			// Виконуємо команди закінчення підписки
			if (config.expiry_commands && Array.isArray(config.expiry_commands)) {
				const serverId = config.server_id || 'MFS';

				for (let command of config.expiry_commands) {
					const processedCommand = this.replacePlaceholders(command, {
						minecraft_nick: subscription.minecraft_nick
					});

					const result = await rconService.executeCommand(serverId, processedCommand);

					if (!result.success) {
						console.error(`❌ Помилка виконання команди закінчення підписки: ${result.error}`);
					} else {
						console.log(`✅ Виконано команду закінчення підписки: ${processedCommand}`);
					}

					// Затримка між командами
					await new Promise(resolve => setTimeout(resolve, 500));
				}
			}

			// Деактивуємо підписку
			await conn.query(
				'UPDATE subscriptions SET is_active = 0, updated_at = ? WHERE id = ?',
				[Math.floor(Date.now() / 1000), subscription.id]
			);

			console.log(`✅ Підписка ${subscription.id} для ${subscription.minecraft_nick} деактивована`);

		} catch (error) {
			console.error(`❌ Помилка обробки закінченої підписки ${subscription.id}:`, error);
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

		// Перевірка закінчених підписок кожну годину
		cron.schedule('0 * * * *', () => {
			this.processExpiredSubscriptions();
		});

		console.log('✅ Планувальник завдань магазину запущено');
	}
}

export default new ShopService();