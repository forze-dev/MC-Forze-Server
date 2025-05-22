import { Router } from 'express';
import {
	getAllProducts,
	getProductById,
	createProduct,
	updateProduct,
	deleteProduct,
	getProductCategories,
	getProductTypes
} from '../controllers/products.controller.js';
import { uploadProductImages, processProductImages } from '../middlewares/fileUpload.middleware.js';
import { isAdmin } from '../middlewares/checkToken.middleware.js';

const productsRouter = new Router();

// Публічні маршрути
productsRouter.get('/', getAllProducts);
productsRouter.get('/categories', getProductCategories);
productsRouter.get('/types', getProductTypes);
productsRouter.get('/:id', getProductById);

// Адміністративні маршрути
productsRouter.post('/', isAdmin, uploadProductImages, processProductImages, createProduct);
productsRouter.put('/:id', isAdmin, uploadProductImages, processProductImages, updateProduct);
productsRouter.delete('/:id', isAdmin, deleteProduct);

export default productsRouter;