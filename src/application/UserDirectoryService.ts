import { InternalUser } from "../domain/InternalUser";
import { UserRepository } from "../infrastructure/base44/UserRepository";

/**
 * NOVO - preparo para a Etapa 2 do plano de reducao de credito (migrar
 * `listInternalUsers` do Base44 pra ca). Ainda nao esta ligado a nenhuma
 * rota publica nem ao frontend do Base44 - falta (1) validar que a conta de
 * servico consegue listar todos os usuarios (ver UserRepository) e (2)
 * editar os 8 pontos do frontend que hoje chamam a function do Base44, o
 * que depende da conexao com o Base44 estar disponivel de novo.
 */
export class UserDirectoryService {
  constructor(private readonly users: UserRepository) {}

  async listAll(): Promise<InternalUser[]> {
    const records = await this.users.listAll();
    return records.map(InternalUser.fromRecord);
  }

  async listActiveByVertical(vertical: string | undefined): Promise<InternalUser[]> {
    const all = await this.listAll();
    return all.filter((user) => user.belongsToVertical(vertical) && user.isActive);
  }

  async listDirectors(): Promise<InternalUser[]> {
    const all = await this.listAll();
    return all.filter((user) => user.isDirector);
  }
}
