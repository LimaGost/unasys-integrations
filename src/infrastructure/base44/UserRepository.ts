import type { Base44Client, EntityHandler } from "@base44/sdk";
import { callBase44 } from "../../services/base44Client";

export interface InternalUserRecord {
  id: string;
  email: string;
  full_name?: string;
  vertical?: string;
  cargo?: string;
  tipo_perfil?: string;
  status?: string;
  [key: string]: unknown;
}

/**
 * NOVO - preparo para a Etapa 2 (migrar `listInternalUsers` pra fora do
 * Base44). A entity `User` do Base44 tem regra de acesso propria: um usuario
 * comum so ve o proprio registro; listar TODOS exige `asServiceRole`, um
 * poder que so existe dentro de functions hospedadas no Base44.
 *
 * Aqui fora, dependemos de a conta de servico (BASE44_SERVICE_EMAIL) ja ter
 * papel elevado o suficiente no app para listar todos os usuarios. ISSO
 * AINDA NAO FOI VALIDADO contra o app real - se a conta nao tiver esse
 * papel, `listAll()` provavelmente retorna so o proprio registro da conta de
 * servico. Testar antes de expor isso numa rota publica.
 */
export class UserRepository {
  async listAll(): Promise<InternalUserRecord[]> {
    return callBase44(async (client: Base44Client) => {
      const handler = client.entities.User as unknown as EntityHandler<InternalUserRecord>;
      return handler.list() as Promise<InternalUserRecord[]>;
    });
  }
}
