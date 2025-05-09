import { Router } from "express";
import { register, addReferrer } from "../controllers/players.controller.js";

const playersRouter = new Router()

playersRouter.post("/register", register)
playersRouter.post("/add-reffer", addReferrer)

export default playersRouter