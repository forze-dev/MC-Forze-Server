import { Router } from 'express';
import { playerLogin, refreshToken, verifyToken, logout } from '../controllers/auth.controller.js';

const authRouter = new Router();

authRouter.post('/login', playerLogin);
authRouter.post('/refresh', refreshToken);
authRouter.get('/verify', verifyToken);
authRouter.post('/logout', logout);

export default authRouter;