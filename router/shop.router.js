import { Router } from 'express';
import {
	purchaseProduct,
	getPurchaseHistory,
	getPurchaseStatistics,
	getPurchaseDetails
} from '../controllers/shop.controller.js';
import { isPlayer, isAdmin, isPlayerOrAdmin } from '../middlewares/checkToken.middleware.js';

const shopRouter = new Router();

// ==========================================
// ПУБЛІЧНІ МАРШРУТИ (для авторизованих гравців)
// ==========================================

/**
 * POST /shop/purchase
 * Покупка товару
 * Потрібна авторизація гравця
 */
shopRouter.post('/purchase', isPlayer, purchaseProduct);

/**
 * GET /shop/purchases/history
 * Історія покупок поточного гравця
 * Потрібна авторизація гравця
 */
shopRouter.get('/purchases/history', isPlayer, getPurchaseHistory);

/**
 * GET /shop/purchases/:purchaseId
 * Деталі конкретної покупки
 * Гравець може переглядати тільки свої покупки, адмін - будь-які
 */
shopRouter.get('/purchases/:purchaseId', isPlayerOrAdmin, getPurchaseDetails);

// ==========================================
// АДМІНІСТРАТИВНІ МАРШРУТИ (тільки для адмінів)
// ==========================================

/**
 * GET /shop/admin/statistics
 * Статистика покупок для адмінів
 * Потрібні права адміністратора
 */
shopRouter.get('/admin/statistics', isAdmin, getPurchaseStatistics);

// ==========================================
// ДОДАТКОВІ МАРШРУТИ (для майбутнього розширення)
// ==========================================

// TODO: Додати в майбутньому:
// shopRouter.get('/admin/purchases', isAdmin, getAllPurchases); // Всі покупки для адмінів
// shopRouter.post('/admin/purchases/:purchaseId/retry', isAdmin, retryPurchaseExecution); // Повторна спроба виконання
// shopRouter.patch('/admin/purchases/:purchaseId/status', isAdmin, updatePurchaseStatus); // Зміна статусу покупки
// shopRouter.get('/admin/executions/pending', isAdmin, getPendingExecutions); // Невиконані команди
// shopRouter.post('/admin/executions/:executionId/approve', isAdmin, approveExecution); // Підтвердження виконання
// shopRouter.delete('/admin/purchases/:purchaseId', isAdmin, cancelPurchase); // Скасування покупки

export default shopRouter;