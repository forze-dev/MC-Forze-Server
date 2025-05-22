import { Rcon } from 'rcon-client';
import 'dotenv/config';

class MinecraftRconService {
	constructor() {
		this.connections = new Map(); // Зберігаємо з'єднання для кількох серверів
		this.config = {
			servers: [
				{
					id: 'MFS',
					host: process.env.RCON_HOST_MFS || 'localhost',
					port: parseInt(process.env.RCON_PORT_MFS) || 25575,
					password: process.env.RCON_PASSWORD_MFS || 'your_rcon_password'
				}
			],
			reconnectInterval: 5000, // 5 секунд
			maxRetries: 3
		};
	}

	/**
	 * Підключення до RCON сервера
	 * @param {string} serverId ID сервера
	 * @returns {Promise<Rcon|null>}
	 */
	async connect(serverId) {
		try {
			const serverConfig = this.config.servers.find(s => s.id === serverId);
			if (!serverConfig) {
				throw new Error(`Сервер з ID ${serverId} не знайдено`);
			}

			// Перевіряємо чи є активне з'єднання
			if (this.connections.has(serverId)) {
				const existingConnection = this.connections.get(serverId);
				if (existingConnection.socket && !existingConnection.socket.destroyed) {
					return existingConnection;
				}
			}

			console.log(`🔌 Підключення до RCON сервера ${serverId} (${serverConfig.host}:${serverConfig.port})`);

			const rcon = await Rcon.connect({
				host: serverConfig.host,
				port: serverConfig.port,
				password: serverConfig.password,
				timeout: 10000 // 10 секунд таймаут
			});

			// Додаємо обробники подій
			rcon.on('connect', () => {
				console.log(`✅ RCON підключено до сервера ${serverId}`);
			});

			rcon.on('authenticated', () => {
				console.log(`🔐 RCON аутентифіковано на сервері ${serverId}`);
			});

			rcon.on('error', (error) => {
				console.error(`❌ RCON помилка на сервері ${serverId}:`, error);
				this.connections.delete(serverId);
			});

			rcon.on('end', () => {
				console.log(`🔌 RCON з'єднання з сервером ${serverId} закрито`);
				this.connections.delete(serverId);
			});

			// Зберігаємо з'єднання
			this.connections.set(serverId, rcon);
			return rcon;

		} catch (error) {
			console.error(`❌ Помилка підключення RCON до сервера ${serverId}:`, error);
			return null;
		}
	}

	/**
	 * Виконання команди на сервері
	 * @param {string} serverId ID сервера
	 * @param {string} command Команда для виконання
	 * @param {number} maxRetries Максимальна кількість спроб
	 * @returns {Promise<{success: boolean, response?: string, error?: string}>}
	 */
	async executeCommand(serverId, command, maxRetries = 3) {
		let retries = 0;

		while (retries < maxRetries) {
			try {
				let rcon = this.connections.get(serverId);

				// Якщо з'єднання немає або воно зруйноване, підключаємося
				if (!rcon || rcon.socket?.destroyed) {
					rcon = await this.connect(serverId);
				}

				if (!rcon) {
					throw new Error('Не вдалося підключитися до RCON');
				}

				console.log(`🎯 Виконання команди на сервері ${serverId}: ${command}`);

				const response = await rcon.send(command);

				console.log(`✅ Команда виконана успішно на сервері ${serverId}`);

				return {
					success: true,
					response: response || 'Команда виконана успішно'
				};

			} catch (error) {
				retries++;
				console.error(`❌ Спроба ${retries}/${maxRetries} виконання команди на сервері ${serverId} невдала:`, error);

				// Видаляємо з'єднання при помилці
				this.connections.delete(serverId);

				if (retries < maxRetries) {
					console.log(`⏳ Очікування ${this.config.reconnectInterval}ms перед повторною спробою...`);
					await new Promise(resolve => setTimeout(resolve, this.config.reconnectInterval));
				} else {
					return {
						success: false,
						error: `Не вдалося виконати команду після ${maxRetries} спроб: ${error.message}`
					};
				}
			}
		}
	}

	/**
	 * Методи для конкретних ігрових дій
	 */

	/**
	 * Видача предмета гравцю
	 * @param {string} serverId ID сервера
	 * @param {string} playerName Нік гравця
	 * @param {string} itemId ID предмета (minecraft:diamond)
	 * @param {number} amount Кількість
	 * @returns {Promise<{success: boolean, response?: string, error?: string}>}
	 */
	async giveItem(serverId, playerName, itemId, amount = 1) {
		const command = `give ${playerName} ${itemId} ${amount}`;
		return await this.executeCommand(serverId, command);
	}

	/**
	 * Встановлення ігрового режиму
	 * @param {string} serverId ID сервера  
	 * @param {string} playerName Нік гравця
	 * @param {string} gamemode Ігровий режим (survival, creative, adventure, spectator)
	 * @returns {Promise<{success: boolean, response?: string, error?: string}>}
	 */
	async setGamemode(serverId, playerName, gamemode) {
		const command = `gamemode ${gamemode} ${playerName}`;
		return await this.executeCommand(serverId, command);
	}

	/**
	 * Телепортація гравця
	 * @param {string} serverId ID сервера
	 * @param {string} playerName Нік гравця
	 * @param {number} x Координата X
	 * @param {number} y Координата Y
	 * @param {number} z Координата Z
	 * @returns {Promise<{success: boolean, response?: string, error?: string}>}
	 */
	async teleportPlayer(serverId, playerName, x, y, z) {
		const command = `tp ${playerName} ${x} ${y} ${z}`;
		return await this.executeCommand(serverId, command);
	}

	/**
	 * Відправка повідомлення гравцю
	 * @param {string} serverId ID сервера
	 * @param {string} playerName Нік гравця
	 * @param {string} message Повідомлення
	 * @returns {Promise<{success: boolean, response?: string, error?: string}>}
	 */
	async tellPlayer(serverId, playerName, message) {
		const command = `tell ${playerName} ${message}`;
		return await this.executeCommand(serverId, command);
	}

	/**
	 * Відправка повідомлення всім гравцям
	 * @param {string} serverId ID сервера
	 * @param {string} message Повідомлення
	 * @returns {Promise<{success: boolean, response?: string, error?: string}>}
	 */
	async broadcastMessage(serverId, message) {
		const command = `say ${message}`;
		return await this.executeCommand(serverId, command);
	}

	/**
	 * Виконання команди від імені гравця (якщо є права)
	 * @param {string} serverId ID сервера
	 * @param {string} playerName Нік гравця
	 * @param {string} command Команда для виконання
	 * @returns {Promise<{success: boolean, response?: string, error?: string}>}
	 */
	async executeAsPlayer(serverId, playerName, command) {
		const fullCommand = `execute as ${playerName} run ${command}`;
		return await this.executeCommand(serverId, fullCommand);
	}

	/**
	 * Отримання списку онлайн гравців
	 * @param {string} serverId ID сервера
	 * @returns {Promise<{success: boolean, players?: string[], error?: string}>}
	 */
	async getOnlinePlayers(serverId) {
		try {
			const result = await this.executeCommand(serverId, 'list');

			console.log("[RCON RAW] -", result);

			if (result.success && result.response) {
				// Очищаємо кольорові коди з відповіді
				const cleanResponse = result.response.replace(/§[0-9a-fk-or]/gi, '');

				console.log("[RCON CLEAN] -", cleanResponse);
				console.log("[RCON CLEAN JSON] -", JSON.stringify(cleanResponse));

				let players = [];

				// Розбиваємо на рядки
				const lines = cleanResponse.split('\n');
				console.log(`📝 Розбито на ${lines.length} рядків:`);

				lines.forEach((line, index) => {
					console.log(`Рядок ${index}: "${line}" (довжина: ${line.length})`);
				});

				// Проходимо по кожному рядку
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i].trim(); // Видаляємо пробіли з початку і кінця

					console.log(`🔍 Обробляємо рядок ${i}: "${line}"`);

					if (line === '') {
						console.log(`⏭️ Пропускаємо пустий рядок ${i}`);
						continue;
					}

					// Шукаємо формат "роль: нікнейм"
					const colonIndex = line.indexOf(':');

					if (colonIndex > 0) {
						const role = line.substring(0, colonIndex).trim();
						const playerName = line.substring(colonIndex + 1).trim();

						console.log(`🎯 Знайдено двокрапку на позиції ${colonIndex}`);
						console.log(`👤 Роль: "${role}" (довжина: ${role.length})`);
						console.log(`🏷️ Ім'я гравця: "${playerName}" (довжина: ${playerName.length})`);

						if (role.length > 0 && playerName.length > 0) {
							// Робимо першу літеру ролі великою
							const capitalizedRole = role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
							const formattedPlayer = `[${capitalizedRole}] ${playerName}`;

							console.log(`✅ Додаємо гравця: "${formattedPlayer}"`);
							players.push(formattedPlayer);
						} else {
							console.log(`❌ Пропускаємо через пусту роль або ім'я`);
						}
					} else {
						console.log(`❌ Двокрапка не знайдена в рядку: "${line}"`);
					}
				}

				console.log(`🎯 Фінальний список гравців (${players.length}):`, players);

				return {
					success: true,
					players: players
				};
			}

			console.log("❌ Результат неуспішний або немає відповіді");
			return result;

		} catch (error) {
			console.error("❌ Помилка в getOnlinePlayers:", error);
			return {
				success: false,
				error: error.message
			};
		}
	}

	/**
	 * Закриття всіх з'єднань
	 */
	async disconnect(serverId = null) {
		try {
			if (serverId) {
				// Закриваємо конкретне з'єднання
				const rcon = this.connections.get(serverId);
				if (rcon) {
					await rcon.end();
					this.connections.delete(serverId);
					console.log(`🔌 RCON з'єднання з сервером ${serverId} закрито`);
				}
			} else {
				// Закриваємо всі з'єднання
				for (const [id, rcon] of this.connections) {
					try {
						await rcon.end();
						console.log(`🔌 RCON з'єднання з сервером ${id} закрито`);
					} catch (error) {
						console.error(`❌ Помилка закриття RCON з'єднання з сервером ${id}:`, error);
					}
				}
				this.connections.clear();
			}
		} catch (error) {
			console.error('❌ Помилка закриття RCON з\'єднань:', error);
		}
	}

	/**
	 * Перевірка стану з'єднання
	 * @param {string} serverId ID сервера
	 * @returns {boolean}
	 */
	isConnected(serverId) {
		const rcon = this.connections.get(serverId);
		return rcon && rcon.socket && !rcon.socket.destroyed;
	}

	/**
	 * Отримання статусу всіх з'єднань
	 * @returns {Object}
	 */
	getConnectionStatus() {
		const status = {};
		for (const serverId of this.config.servers.map(s => s.id)) {
			status[serverId] = this.isConnected(serverId);
		}
		return status;
	}
}

// Створюємо єдиний екземпляр сервісу
const rconService = new MinecraftRconService();

// Обробка завершення процесу
process.on('SIGINT', async () => {
	console.log('🛑 Отримано сигнал SIGINT, закриваю RCON з\'єднання...');
	await rconService.disconnect();
});

process.on('SIGTERM', async () => {
	console.log('🛑 Отримано сигнал SIGTERM, закриваю RCON з\'єднання...');
	await rconService.disconnect();
});

export default rconService;