import { Router } from 'express';
import {
	sendMessageToPlayer,
	changeGamemode,
	teleportPlayer,
	getOnlinePlayers,
	executeCustomCommand,
	getRconStatus
} from '../controllers/server-actions.controller.js';
import { isPlayer, isAdmin, isSuperAdmin } from '../middlewares/checkToken.middleware.js';

const serverActionsRouter = new Router();

// Публічні маршрути (для авторизованих гравців)
serverActionsRouter.get('/players/online', isPlayer, getOnlinePlayers);

// Адміністративні маршрути (тільки для адмінів)
serverActionsRouter.post('/message/send', isAdmin, sendMessageToPlayer);
serverActionsRouter.post('/player/gamemode', isAdmin, changeGamemode);
serverActionsRouter.post('/player/teleport', isAdmin, teleportPlayer);
serverActionsRouter.get('/rcon/status', isAdmin, getRconStatus);

// Маршрути для суперадмінів
serverActionsRouter.post('/command/execute', isSuperAdmin, executeCustomCommand);

export default serverActionsRouter;