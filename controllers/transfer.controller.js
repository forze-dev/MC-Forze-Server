// controllers/transfer.controller.js
import { pool } from '../services/db.service.js';

const TRANSFER_COMMISSION_PERCENT = 15; // 15% комісія
const MIN_TRANSFER_AMOUNT = 10; // Мінімальна сума переказу

/**
 * Переказ ігрової валюти між гравцями
 */
export async function transferGameBalance(req, res) {
	try {
		const { recipientNick, amount, message } = req.body;
		const senderTelegramId = req.player.telegramId;
		const senderNick = req.player.userData.minecraft_nick;

		// Валідація обов'язкових полів
		if (!recipientNick || !amount) {
			return res.status(400).json({
				message: 'Відсутні обов\'язкові поля (recipientNick, amount)'
			});
		}

		// Валідація суми
		if (amount < MIN_TRANSFER_AMOUNT) {
			return res.status(400).json({
				message: `Мінімальна сума переказу: ${MIN_TRANSFER_AMOUNT} GFC`
			});
		}

		if (amount <= 0 || !Number.isInteger(amount)) {
			return res.status(400).json({
				message: 'Сума переказу має бути цілим додатним числом'
			});
		}

		// Перевірка що гравець не переказує сам собі
		if (senderNick.toLowerCase() === recipientNick.toLowerCase()) {
			return res.status(400).json({
				message: 'Неможливо переказати кошти самому собі'
			});
		}

		const conn = await pool.getConnection();

		try {
			await conn.beginTransaction();

			// 1. Перевіряємо існування отримувача (точний збіг регістру)
			const [recipients] = await conn.query(
				'SELECT telegram_id, minecraft_nick, game_balance FROM users WHERE BINARY minecraft_nick = ?',
				[recipientNick]
			);

			if (recipients.length === 0) {
				// Шукаємо без урахування регістру для підказки
				const [similarRecipients] = await conn.query(
					'SELECT minecraft_nick FROM users WHERE LOWER(minecraft_nick) = LOWER(?) LIMIT 1',
					[recipientNick]
				);

				await conn.rollback();
				conn.release();

				if (similarRecipients.length > 0) {
					return res.status(404).json({
						message: 'Гравця не знайдено. Можливо, ви мали на увазі:',
						suggestion: similarRecipients[0].minecraft_nick
					});
				} else {
					return res.status(404).json({
						message: `Гравця з ніком "${recipientNick}" не знайдено`
					});
				}
			}

			const recipient = recipients[0];
			const recipientTelegramId = recipient.telegram_id;

			// 2. Перевіряємо баланс відправника
			const senderBalance = req.player.userData.game_balance;
			const commission = Math.ceil(amount * TRANSFER_COMMISSION_PERCENT / 100);
			const totalDeduction = amount + commission;

			if (senderBalance < totalDeduction) {
				await conn.rollback();
				conn.release();
				return res.status(400).json({
					message: `Недостатньо коштів. Потрібно: ${totalDeduction} GFC (${amount} + ${commission} комісія), у вас: ${senderBalance} GFC`
				});
			}

			// 3. Виконуємо переказ
			const now = Math.floor(Date.now() / 1000);

			// Списуємо з відправника
			await conn.query(
				'UPDATE users SET game_balance = game_balance - ?, updated_at = ? WHERE telegram_id = ?',
				[totalDeduction, now, senderTelegramId]
			);

			// Додаємо отримувачу
			await conn.query(
				'UPDATE users SET game_balance = game_balance + ?, updated_at = ? WHERE telegram_id = ?',
				[amount, now, recipientTelegramId]
			);

			// 4. Створюємо запис про переказ
			const [transferResult] = await conn.query(
				`INSERT INTO transfers 
                 (sender_telegram_id, sender_nick, recipient_telegram_id, recipient_nick, 
                  amount, commission, total_deducted, message, created_at, status) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed')`,
				[senderTelegramId, senderNick, recipientTelegramId, recipient.minecraft_nick,
					amount, commission, totalDeduction, message || null, now]
			);

			await conn.commit();

			return res.status(200).json({
				message: 'Переказ успішно виконано!',
				transfer: {
					id: transferResult.insertId,
					recipient: recipient.minecraft_nick,
					amount: amount,
					commission: commission,
					totalDeducted: totalDeduction,
					newBalance: senderBalance - totalDeduction,
					timestamp: now
				}
			});

		} catch (error) {
			await conn.rollback();
			throw error;
		} finally {
			conn.release();
		}

	} catch (error) {
		console.error('❌ Помилка переказу коштів:', error);
		return res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
}

/**
 * Отримання історії переказів гравця
 */
export async function getTransferHistory(req, res) {
	try {
		const telegramId = req.player.telegramId;
		const { page = 1, limit = 20, type = 'all' } = req.query;

		const offset = (parseInt(page) - 1) * parseInt(limit);

		let whereCondition = '';
		let params = [telegramId, telegramId];

		switch (type) {
			case 'sent':
				whereCondition = 'WHERE sender_telegram_id = ?';
				params = [telegramId];
				break;
			case 'received':
				whereCondition = 'WHERE recipient_telegram_id = ?';
				params = [telegramId];
				break;
			case 'all':
			default:
				whereCondition = 'WHERE sender_telegram_id = ? OR recipient_telegram_id = ?';
				break;
		}

		const conn = await pool.getConnection();

		try {
			// Отримуємо історію переказів
			const [transfers] = await conn.query(
				`SELECT id, sender_telegram_id, sender_nick, recipient_telegram_id, recipient_nick,
                        amount, commission, total_deducted, message, created_at, status
                 FROM transfers 
                 ${whereCondition}
                 ORDER BY created_at DESC
                 LIMIT ? OFFSET ?`,
				[...params, parseInt(limit), offset]
			);

			// Отримуємо загальну кількість
			const [totalCount] = await conn.query(
				`SELECT COUNT(*) as total FROM transfers ${whereCondition}`,
				params
			);

			const total = totalCount[0].total;
			const totalPages = Math.ceil(total / parseInt(limit));

			// Форматуємо результат
			const formattedTransfers = transfers.map(transfer => ({
				id: transfer.id,
				type: transfer.sender_telegram_id === telegramId ? 'sent' : 'received',
				sender: transfer.sender_nick,
				recipient: transfer.recipient_nick,
				amount: transfer.amount,
				commission: transfer.commission,
				totalDeducted: transfer.total_deducted,
				message: transfer.message,
				createdAt: transfer.created_at,
				status: transfer.status
			}));

			return res.status(200).json({
				transfers: formattedTransfers,
				pagination: {
					currentPage: parseInt(page),
					totalPages,
					totalItems: total,
					hasNextPage: parseInt(page) < totalPages,
					hasPreviousPage: parseInt(page) > 1
				}
			});

		} finally {
			conn.release();
		}

	} catch (error) {
		console.error('❌ Помилка отримання історії переказів:', error);
		return res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
}

/**
 * Отримання статистики переказів гравця
 */
export async function getTransferStats(req, res) {
	try {
		const telegramId = req.player.telegramId;

		const conn = await pool.getConnection();

		try {
			// Статистика відправлених переказів
			const [sentStats] = await conn.query(
				`SELECT 
                    COUNT(*) as count,
                    COALESCE(SUM(amount), 0) as total_amount,
                    COALESCE(SUM(commission), 0) as total_commission,
                    COALESCE(SUM(total_deducted), 0) as total_deducted
                 FROM transfers 
                 WHERE sender_telegram_id = ? AND status = 'completed'`,
				[telegramId]
			);

			// Статистика отриманих переказів
			const [receivedStats] = await conn.query(
				`SELECT 
                    COUNT(*) as count,
                    COALESCE(SUM(amount), 0) as total_amount
                 FROM transfers 
                 WHERE recipient_telegram_id = ? AND status = 'completed'`,
				[telegramId]
			);

			return res.status(200).json({
				sent: {
					count: sentStats[0].count,
					totalAmount: sentStats[0].total_amount,
					totalCommission: sentStats[0].total_commission,
					totalDeducted: sentStats[0].total_deducted
				},
				received: {
					count: receivedStats[0].count,
					totalAmount: receivedStats[0].total_amount
				},
				commission: {
					percent: TRANSFER_COMMISSION_PERCENT,
					minTransferAmount: MIN_TRANSFER_AMOUNT
				}
			});

		} finally {
			conn.release();
		}

	} catch (error) {
		console.error('❌ Помилка отримання статистики переказів:', error);
		return res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
}

/**
 * Розрахунок комісії для переказу
 */
export async function calculateTransferCommission(req, res) {
	try {
		const { amount } = req.query;

		if (!amount || amount <= 0) {
			return res.status(400).json({ message: 'Некоректна сума' });
		}

		const transferAmount = parseInt(amount);
		const commission = Math.ceil(transferAmount * TRANSFER_COMMISSION_PERCENT / 100);
		const totalDeduction = transferAmount + commission;

		return res.status(200).json({
			amount: transferAmount,
			commission: commission,
			totalDeduction: totalDeduction,
			commissionPercent: TRANSFER_COMMISSION_PERCENT,
			minTransferAmount: MIN_TRANSFER_AMOUNT
		});

	} catch (error) {
		console.error('❌ Помилка розрахунку комісії:', error);
		return res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
}