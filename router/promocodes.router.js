// router/promocodes.router.js
// Маршрути для роботи з промокодами - публічні та адміністративні

import { Router } from 'express';
import {
	validatePromocode,
	createPromocode,
	getAllPromocodes,
	deactivatePromocode
} from '../controllers/promocodes.controller.js';
import { isAdmin } from '../middlewares/checkToken.middleware.js';

const promocodesRouter = new Router();

// ==========================================
// ПУБЛІЧНІ МАРШРУТИ (для всіх користувачів)
// ==========================================

/**
 * GET /promocodes/validate?code=MYCODE&productId=123
 * Перевірка валідності промокоду перед покупкою
 * Доступно всім користувачам
 */
promocodesRouter.get('/validate', validatePromocode);

// ==========================================
// АДМІНІСТРАТИВНІ МАРШРУТИ (тільки для адмінів)
// ==========================================

/**
 * POST /promocodes/admin/create
 * Створення нового промокоду
 * Потрібні права адміністратора
 */
promocodesRouter.post('/admin/create', isAdmin, createPromocode);

/**
 * GET /promocodes/admin
 * Отримання списку всіх промокодів
 * Потрібні права адміністратора
 */
promocodesRouter.get('/admin', isAdmin, getAllPromocodes);

/**
 * PATCH /promocodes/admin/:id/deactivate
 * Деактивація промокоду
 * Потрібні права адміністратора
 */
promocodesRouter.patch('/admin/:id/deactivate', isAdmin, deactivatePromocode);

export default promocodesRouter;