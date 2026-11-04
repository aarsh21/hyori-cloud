import type {
  CreateInvite,
  CreateUser,
  DeleteUser,
  SetQuota,
  UsersInput,
} from "#core/features/admin/api/schema";
import { AdminService } from "#core/features/admin/service";
import type { RequestContext } from "#core/runtime";

export function adminHandlers(context: RequestContext) {
  const service = new AdminService(context);

  return {
    "admin.users": (input: typeof UsersInput.Type) => service.users(input),
    "admin.createUser": (input: typeof CreateUser.Type) => service.createUser(input),
    "admin.createInvite": (input: typeof CreateInvite.Type) => service.createInvite(input),
    "admin.setQuota": (input: typeof SetQuota.Type) => service.setQuota(input),
    "admin.deleteUser": (input: typeof DeleteUser.Type) => service.deleteUser(input),
  };
}
