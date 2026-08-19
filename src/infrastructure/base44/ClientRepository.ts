import type { Base44Client } from "@base44/sdk";
import { callBase44 } from "../../services/base44Client";
import { findOrCreateClient, getEntities } from "../../services/base44Entities";
import type { Client, ClientRecord } from "../../types/entities";
import { BaseRepository } from "./BaseRepository";

export class ClientRepository extends BaseRepository<ClientRecord> {
  protected handler(client: Base44Client) {
    return getEntities(client).Client;
  }

  /** Reaproveita a mesma logica de busca-ou-criacao ja usada pelo webhook de vendas (base44Entities.ts). */
  async findOrCreate(lookup: { cnpj?: string; email?: string }, createData: Client): Promise<ClientRecord> {
    return callBase44((client) => findOrCreateClient(getEntities(client), lookup, createData));
  }
}
