import { Router } from 'express';
import { adminLogin, verifyAdminToken } from '../controllers/admin-auth.controller.js';

const adminAuthRouter = new Router();

// Маршрути для авторизації адміністраторів
adminAuthRouter.post('/login', adminLogin);
adminAuthRouter.get('/verify', verifyAdminToken);

export default adminAuthRouter;