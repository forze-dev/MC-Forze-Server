// router/transfer.router.js
import { Router } from 'express';
import {
	transferGameBalance,
	getTransferHistory,
	getTransferStats,
	calculateTransferCommission
} from '../controllers/transfer.controller.js';
import { isPlayer } from '../middlewares/checkToken.middleware.js';

const transferRouter = new Router();

// ==========================================
// ОСНОВНІ МАРШРУТИ ПЕРЕКАЗІВ (для авторизованих гравців)
// ==========================================

/**
 * POST /transfer/send
 * Переказ ігрової валюти іншому гравцю
 * Потрібна авторизація гравця
 */
transferRouter.post('/send', isPlayer, transferGameBalance);

/**
 * GET /transfer/history
 * Історія переказів поточного гравця
 * Параметри: ?page=1&limit=20&type=all|sent|received
 * Потрібна авторизація гравця
 */
transferRouter.get('/history', isPlayer, getTransferHistory);

/**
 * GET /transfer/stats
 * Статистика переказів поточного гравця
 * Потрібна авторизація гравця
 */
transferRouter.get('/stats', isPlayer, getTransferStats);

/**
 * GET /transfer/calculate-commission
 * Розрахунок комісії для переказу
 * Параметри: ?amount=100
 * Публічний маршрут (не потребує авторизації)
 */
transferRouter.get('/calculate-commission', calculateTransferCommission);

// ==========================================
// АДМІНІСТРАТИВНІ МАРШРУТИ (для майбутнього розширення)
// ==========================================

// TODO: Додати в майбутньому:
// transferRouter.get('/admin/all', isAdmin, getAllTransfers); // Всі перекази для адмінів
// transferRouter.patch('/admin/:transferId/cancel', isAdmin, cancelTransfer); // Скасування переказу
// transferRouter.get('/admin/stats', isAdmin, getGlobalTransferStats); // Глобальна статистика
// transferRouter.post('/admin/refund/:transferId', isAdmin, refundTransfer); // Повернення коштів

export default transferRouter;