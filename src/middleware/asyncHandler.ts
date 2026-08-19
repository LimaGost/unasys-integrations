import type { NextFunction, Request, Response } from "express";

type AsyncRouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

/**
 * Envolve um handler de rota assincrono para que rejeicoes de promise sejam
 * encaminhadas ao middleware de erro do Express (`next(error)`) em vez de
 * derrubar o processo (Express 4 nao faz isso automaticamente).
 */
export function asyncHandler(handler: AsyncRouteHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}
