import { Base44Error, type Base44Client, type EntityHandler } from "@base44/sdk";
import { callBase44 } from "../../services/base44Client";

/**
 * Base para repositories que encapsulam o acesso a UMA entity do Base44.
 * Cada subclasse so precisa dizer qual e o handler (`entities.Ticket`,
 * `entities.Client`, etc.) - toda a mecanica de autenticacao/retry (via
 * `callBase44`) fica centralizada aqui, em vez de espalhada pelo codigo de
 * negocio (era assim antes, com `callBase44(...)` chamado direto nas rotas).
 */
export abstract class BaseRepository<TRecord extends { id: string }> {
  protected abstract handler(client: Base44Client): EntityHandler<TRecord>;

  async findById(id: string): Promise<TRecord | null> {
    try {
      return await callBase44((client) => this.handler(client).get(id));
    } catch (error) {
      if (error instanceof Base44Error && error.status === 404) return null;
      throw error;
    }
  }

  async findOne(query: Record<string, unknown>, sort?: string): Promise<TRecord | null> {
    const results = await this.findMany(query, sort, 1);
    return results[0] ?? null;
  }

  async findMany(query: Record<string, unknown>, sort?: string, limit?: number): Promise<TRecord[]> {
    return callBase44((client) => this.handler(client).filter(query as never, sort as never, limit)) as Promise<TRecord[]>;
  }

  async list(sort?: string, limit?: number): Promise<TRecord[]> {
    return callBase44((client) => this.handler(client).list(sort as never, limit)) as Promise<TRecord[]>;
  }

  async create(data: Partial<TRecord>): Promise<TRecord> {
    return callBase44((client) => this.handler(client).create(data));
  }

  async update(id: string, data: Partial<TRecord>): Promise<TRecord> {
    return callBase44((client) => this.handler(client).update(id, data));
  }
}
