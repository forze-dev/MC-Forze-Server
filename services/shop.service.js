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
						result = await this._processItemPurchase(conn, product, purchaseData);
						break;

					case 'subscription':
						// TODO: Буде реалізовано пізніше
						throw new Error('Тип товару "subscription" поки не підтримується');

					case 'rank':
						result = await this._processRankPurchase(conn, product, purchaseData);
						break;

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

	// Додайте ці методи в клас ShopService

	/**
	 * Приватний метод обробки покупки предметів
	 * @param {Object} conn - З'єднання з базою даних
	 * @param {Object} product - Інформація про товар
	 * @param {Object} purchaseData - Дані про покупку
	 * @returns {Promise<Object>} Результат обробки
	 */
	async _processItemPurchase(conn, product, purchaseData) {
		const { telegramId, minecraftNick, purchaseId, quantity = 1 } = purchaseData;

		console.log(`📦 Обробка предметів для ${minecraftNick} (кількість: ${quantity})`);

		// Створюємо запис виконання
		const now = Math.floor(Date.now() / 1000);
		const [executionResult] = await conn.query(
			`INSERT INTO product_executions 
		 (purchase_id, telegram_id, product_id, execution_type, execution_status, created_at) 
		 VALUES (?, ?, ?, 'item_give', 'pending', ?)`,
			[purchaseId, telegramId, product.id, now]
		);

		const executionId = executionResult.insertId;

		// Перевіряємо чи потрібно автоматично виконувати
		if (product.auto_execute && !product.requires_manual_approval) {
			console.log(`🚀 Автоматична видача предметів для ${minecraftNick}`);

			const executionResult = await this._executeItemCommands(
				product,
				minecraftNick,
				quantity,
				conn,
				executionId
			);

			return {
				message: executionResult.message,
				executionResults: executionResult.executionResults,
				autoExecuted: true,
				hasStorageItems: executionResult.hasStorageItems
			};
		} else {
			// Потрібна ручна обробка
			await conn.query(
				'UPDATE product_executions SET execution_status = ? WHERE id = ?',
				['manual_required', executionId]
			);

			return {
				message: product.requires_manual_approval
					? 'Запит на видачу предметів відправлено. Адміністратор розгляне його найближчим часом.'
					: 'Запит на видачу предметів створено.',
				requiresManualAction: true,
				autoExecuted: false,
				hasStorageItems: true
			};
		}
	}

	/**
	 * Приватний метод виконання команд видачі предметів
	 * @param {Object} product - Інформація про товар
	 * @param {string} minecraftNick - Minecraft нікнейм
	 * @param {number} quantity - Кількість наборів
	 * @param {Object} conn - З'єднання з базою даних
	 * @param {number} executionId - ID запису виконання
	 * @returns {Promise<Object>} Результат виконання
	 */
	async _executeItemCommands(product, minecraftNick, quantity, conn, executionId) {
		try {
			const executionConfig = product.execution_config || {};
			const serverId = executionConfig.server_id || 'MFS';
			const deliveryMethod = executionConfig.delivery_method || 'storage';

			let commands = [];
			let executionResults = [];
			let hasStorageItems = false;

			// Якщо є готові RCON команди в конфігурації
			if (executionConfig.rcon_commands && Array.isArray(executionConfig.rcon_commands)) {
				commands = executionConfig.rcon_commands.map(cmd =>
					this._replacePlaceholders(cmd, { minecraft_nick: minecraftNick })
				);
				hasStorageItems = deliveryMethod === 'storage';
			}
			// Інакше генеруємо команди з items_data
			else if (product.items_data) {
				const result = this._generateItemCommands(product, minecraftNick, quantity);
				commands = result.commands;
				hasStorageItems = result.hasStorageItems;
			}
			else {
				throw new Error('Не знайдено команд або предметів для видачі');
			}

			console.log(`🎯 Виконання ${commands.length} команд для видачі предметів`);

			// Виконуємо кожну команду послідовно
			for (let i = 0; i < commands.length; i++) {
				const command = commands[i];

				console.log(`🔧 Команда ${i + 1}/${commands.length}: ${command}`);

				try {
					const result = await rconService.executeCommand(serverId, command);

					executionResults.push({
						command: command,
						success: result.success,
						response: result.response || result.error,
						order: i + 1
					});

					if (!result.success) {
						console.error(`❌ Команда ${i + 1} провалилась: ${result.error}`);
					} else {
						console.log(`✅ Команда ${i + 1} виконана успішно`);
					}

					// Невелика затримка між командами
					if (i < commands.length - 1) {
						await new Promise(resolve => setTimeout(resolve, 300));
					}

				} catch (cmdError) {
					console.error(`❌ Помилка виконання команди ${i + 1}:`, cmdError);

					executionResults.push({
						command: command,
						success: false,
						response: cmdError.message,
						order: i + 1
					});
				}
			}

			const now = Math.floor(Date.now() / 1000);
			const allSuccess = executionResults.every(result => result.success);
			const successCount = executionResults.filter(result => result.success).length;

			if (allSuccess) {
				// Всі команди виконані успішно
				await conn.query(
					'UPDATE product_executions SET execution_status = ?, execution_result = ?, command_executed = ?, executed_at = ? WHERE id = ?',
					['success', JSON.stringify(executionResults), `${successCount}/${commands.length} команд`, now, executionId]
				);

				console.log(`✅ Предмети для ${minecraftNick} успішно видано (${successCount}/${commands.length} команд)`);

				const message = hasStorageItems
					? 'Предмети успішно додано у ваше персональне сховище!'
					: 'Предмети успішно видано!';

				return {
					success: true,
					message: `${message} Виконано ${successCount} команд.`,
					executionResults: executionResults,
					hasStorageItems: hasStorageItems
				};
			} else {
				// Деякі команди провалились
				const failedCount = commands.length - successCount;

				await conn.query(
					'UPDATE product_executions SET execution_status = ?, execution_result = ?, command_executed = ?, retry_count = retry_count + 1 WHERE id = ?',
					['failed', JSON.stringify(executionResults), `${successCount}/${commands.length} команд`, executionId]
				);

				throw new Error(`Видача предметів частково провалилась: ${failedCount} з ${commands.length} команд не виконались`);
			}

		} catch (error) {
			console.error('❌ Помилка виконання команд видачі предметів:', error);

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
	 * Приватний метод генерації команд з items_data
	 * @param {Object} product - Інформація про товар
	 * @param {string} minecraftNick - Minecraft нікнейм
	 * @param {number} quantity - Кількість наборів
	 * @returns {Object} Команди та метод доставки
	 */
	_generateItemCommands(product, minecraftNick, quantity) {
		try {
			let itemsData = [];

			// Парсимо items_data
			if (typeof product.items_data === 'string') {
				itemsData = JSON.parse(product.items_data);
			} else if (Array.isArray(product.items_data)) {
				itemsData = product.items_data;
			} else {
				throw new Error('Некоректний формат items_data');
			}

			const executionConfig = product.execution_config || {};
			const deliveryMethod = executionConfig.delivery_method || 'storage';
			const commands = [];

			// Генеруємо команди для кожного предмета
			itemsData.forEach(item => {
				const itemId = item.minecraft_id;
				const amount = (item.amount || 1) * quantity;

				let command;

				if (deliveryMethod === 'storage') {
					// Використовуємо ваш плагін сховища
					if (item.nbt) {
						command = `storage add ${minecraftNick} ${itemId}${item.nbt} ${amount}`;
					} else {
						command = `storage add ${minecraftNick} ${itemId} ${amount}`;
					}
				} else {
					// Звичайна команда give
					if (item.nbt) {
						command = `give ${minecraftNick} ${itemId}${item.nbt} ${amount}`;
					} else {
						command = `give ${minecraftNick} ${itemId} ${amount}`;
					}
				}

				commands.push(command);
			});

			// Додаємо повідомлення гравцю
			if (deliveryMethod === 'storage') {
				commands.push(`tell ${minecraftNick} Предмети додано у ваше персональне сховище! Відкрийте його командою /storage open`);
			} else {
				commands.push(`tell ${minecraftNick} Ви отримали предмети: ${product.name}!`);
			}

			return {
				commands: commands,
				hasStorageItems: deliveryMethod === 'storage'
			};

		} catch (error) {
			console.error('❌ Помилка генерації команд предметів:', error);
			throw new Error('Не вдалося згенерувати команди для видачі предметів');
		}
	}

	/**
	 * Приватний метод повторної спроби виконання команд предметів
	 * @param {Object} conn - З'єднання з базою даних
	 * @param {Object} execution - Запис виконання
	 */
	async _retryItemExecution(conn, execution) {
		try {
			// Отримуємо продукт для повторного виконання
			const [products] = await conn.query(
				'SELECT * FROM products WHERE id = ?',
				[execution.product_id]
			);

			if (products.length === 0) {
				throw new Error('Товар не знайдено');
			}

			const product = products[0];

			// Парсимо execution_config
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

			console.log(`🔄 Повторна видача предметів для ${execution.minecraft_nick}`);

			// Виконуємо команди предметів
			const result = await this._executeItemCommands(
				product,
				execution.minecraft_nick,
				1, // quantity = 1 для повторної спроби
				conn,
				execution.id
			);

			console.log(`✅ Повторна спроба успішна: предмети для ${execution.minecraft_nick} видано`);

		} catch (error) {
			// Збільшуємо лічильник спроб
			const newRetryCount = execution.retry_count + 1;
			const status = newRetryCount >= execution.max_retries ? 'failed' : 'pending';

			await conn.query(
				'UPDATE product_executions SET retry_count = ?, execution_status = ?, execution_result = ? WHERE id = ?',
				[newRetryCount, status, error.message, execution.id]
			);

			console.log(`❌ Спроба ${newRetryCount}/${execution.max_retries} для предметів ${execution.minecraft_nick}: ${error.message}`);
		}
	}

	/**
 * Приватний метод обробки покупки ранку
 * @param {Object} conn - З'єднання з базою даних
 * @param {Object} product - Інформація про товар
 * @param {Object} purchaseData - Дані про покупку
 * @returns {Promise<Object>} Результат обробки
 */
	async _processRankPurchase(conn, product, purchaseData) {
		const { telegramId, minecraftNick, purchaseId } = purchaseData;

		console.log(`🎖️ Обробка ранку для ${minecraftNick}`);

		// Створюємо запис виконання
		const now = Math.floor(Date.now() / 1000);
		const [executionResult] = await conn.query(
			`INSERT INTO product_executions 
		 (purchase_id, telegram_id, product_id, execution_type, execution_status, created_at) 
		 VALUES (?, ?, ?, 'rank_set', 'pending', ?)`,
			[purchaseId, telegramId, product.id, now]
		);

		const executionId = executionResult.insertId;

		// Перевіряємо чи потрібно автоматично виконувати
		if (product.auto_execute && !product.requires_manual_approval) {
			console.log(`🚀 Автоматичне встановлення ранку для ${minecraftNick}`);

			const executionResult = await this._executeRankCommands(
				product.execution_config,
				minecraftNick,
				conn,
				executionId
			);

			return {
				message: 'Твій ранг успішно встановлено!',
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
					? 'Запит на встановлення ранку відправлено. Адміністратор розгляне його найближчим часом.'
					: 'Запит на встановлення ранку створено.',
				requiresManualAction: true,
				autoExecuted: false
			};
		}
	}

	/**
	 * Приватний метод виконання команд встановлення ранку
	 * @param {Object} executionConfig - Конфігурація виконання
	 * @param {string} minecraftNick - Minecraft нікнейм
	 * @param {Object} conn - З'єднання з базою даних
	 * @param {number} executionId - ID запису виконання
	 * @returns {Promise<Object>} Результат виконання
	 */
	async _executeRankCommands(executionConfig, minecraftNick, conn, executionId) {
		try {
			const serverId = executionConfig.server_id || 'MFS';
			const executionResults = [];

			// Отримуємо команди з конфігурації
			let commands = [];

			if (executionConfig.commands && Array.isArray(executionConfig.commands)) {
				commands = executionConfig.commands;
			} else if (executionConfig.rcon_commands && Array.isArray(executionConfig.rcon_commands)) {
				commands = executionConfig.rcon_commands;
			} else {
				throw new Error('Не знайдено команд для виконання в конфігурації ранку');
			}

			console.log(`🎯 Виконання ${commands.length} команд для встановлення ранку`);

			// Виконуємо кожну команду послідовно
			for (let i = 0; i < commands.length; i++) {
				const rawCommand = commands[i];
				const command = this._replacePlaceholders(rawCommand, {
					minecraft_nick: minecraftNick
				});

				console.log(`🔧 Команда ${i + 1}/${commands.length}: ${command}`);

				try {
					const result = await rconService.executeCommand(serverId, command);

					executionResults.push({
						command: command,
						success: result.success,
						response: result.response || result.error,
						order: i + 1
					});

					if (!result.success) {
						console.error(`❌ Команда ${i + 1} провалилась: ${result.error}`);
						// Продовжуємо виконання інших команд, але записуємо помилку
					} else {
						console.log(`✅ Команда ${i + 1} виконана успішно`);
					}

					// Невелика затримка між командами
					if (i < commands.length - 1) {
						await new Promise(resolve => setTimeout(resolve, 500));
					}

				} catch (cmdError) {
					console.error(`❌ Помилка виконання команди ${i + 1}:`, cmdError);

					executionResults.push({
						command: command,
						success: false,
						response: cmdError.message,
						order: i + 1
					});
				}
			}

			const now = Math.floor(Date.now() / 1000);
			const allSuccess = executionResults.every(result => result.success);
			const successCount = executionResults.filter(result => result.success).length;

			if (allSuccess) {
				// Всі команди виконані успішно
				await conn.query(
					'UPDATE product_executions SET execution_status = ?, execution_result = ?, command_executed = ?, executed_at = ? WHERE id = ?',
					['success', JSON.stringify(executionResults), `${successCount}/${commands.length} команд`, now, executionId]
				);

				console.log(`✅ Ранг для ${minecraftNick} успішно встановлено (${successCount}/${commands.length} команд)`);

				return {
					success: true,
					message: `Твій ранг успішно встановлено! Виконано ${successCount} команд.`,
					executionResults: executionResults
				};
			} else {
				// Деякі команди провалились
				const failedCount = commands.length - successCount;

				await conn.query(
					'UPDATE product_executions SET execution_status = ?, execution_result = ?, command_executed = ?, retry_count = retry_count + 1 WHERE id = ?',
					['failed', JSON.stringify(executionResults), `${successCount}/${commands.length} команд`, executionId]
				);

				throw new Error(`Встановлення ранку частково провалилось: ${failedCount} з ${commands.length} команд не виконались`);
			}

		} catch (error) {
			console.error('❌ Помилка виконання команд ранку:', error);

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

				case 'rank_set':
					await this._retryRankExecution(conn, execution);
					break;

				case 'item_give':
					await this._retryItemExecution(conn, execution);
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
 * Приватний метод повторної спроби виконання команд ранку
 * @param {Object} conn - З'єднання з базою даних
 * @param {Object} execution - Запис виконання
 */
	async _retryRankExecution(conn, execution) {
		try {
			let executionConfig = {};
			try {
				executionConfig = typeof execution.execution_config === 'string'
					? JSON.parse(execution.execution_config)
					: execution.execution_config || {};
			} catch (e) {
				throw new Error('Некоректна конфігурація команд ранку');
			}

			const serverId = executionConfig.server_id || 'MFS';
			const executionResults = [];

			// Отримуємо команди
			let commands = [];
			if (executionConfig.commands && Array.isArray(executionConfig.commands)) {
				commands = executionConfig.commands;
			} else if (executionConfig.rcon_commands && Array.isArray(executionConfig.rcon_commands)) {
				commands = executionConfig.rcon_commands;
			} else {
				throw new Error('Не знайдено команд для повторного виконання');
			}

			console.log(`🔄 Повторне виконання ${commands.length} команд ранку для ${execution.minecraft_nick}`);

			// Виконуємо команди
			for (let i = 0; i < commands.length; i++) {
				const rawCommand = commands[i];
				const command = this._replacePlaceholders(rawCommand, {
					minecraft_nick: execution.minecraft_nick
				});

				try {
					const result = await rconService.executeCommand(serverId, command);

					executionResults.push({
						command: command,
						success: result.success,
						response: result.response || result.error,
						order: i + 1
					});

					if (i < commands.length - 1) {
						await new Promise(resolve => setTimeout(resolve, 500));
					}

				} catch (cmdError) {
					executionResults.push({
						command: command,
						success: false,
						response: cmdError.message,
						order: i + 1
					});
				}
			}

			const now = Math.floor(Date.now() / 1000);
			const allSuccess = executionResults.every(result => result.success);
			const successCount = executionResults.filter(result => result.success).length;

			if (allSuccess) {
				// Успішне виконання
				await conn.query(
					'UPDATE product_executions SET execution_status = ?, execution_result = ?, command_executed = ?, executed_at = ? WHERE id = ?',
					['success', JSON.stringify(executionResults), `${successCount}/${commands.length} команд`, now, execution.id]
				);

				console.log(`✅ Повторна спроба успішна: ранг для ${execution.minecraft_nick} встановлено`);
			} else {
				throw new Error(`Повторна спроба частково провалилась: ${commands.length - successCount} команд не виконались`);
			}

		} catch (error) {
			// Збільшуємо лічильник спроб
			const newRetryCount = execution.retry_count + 1;
			const status = newRetryCount >= execution.max_retries ? 'failed' : 'pending';

			await conn.query(
				'UPDATE product_executions SET retry_count = ?, execution_status = ?, execution_result = ? WHERE id = ?',
				[newRetryCount, status, error.message, execution.id]
			);

			console.log(`❌ Спроба ${newRetryCount}/${execution.max_retries} для ранку ${execution.minecraft_nick}: ${error.message}`);
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