import { ConflictException } from '@nestjs/common';
import { generateToken, hashPassword } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto';

/**
 * Create a user, or reset an existing user's password when `force` is set. Used by the
 * role-gated admin UI. A freshly generated password is returned once when none was supplied.
 */
export async function createOrResetUser(prisma: PrismaService, dto: CreateUserDto) {
  const email = dto.email.trim();
  const name = dto.name?.trim() || email.split('@')[0];

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing && !dto.force) {
    throw new ConflictException(`user ${email} already exists (set force to reset their password)`);
  }

  let password = dto.password;
  let generated = false;
  if (!password) {
    password = generateToken(12);
    generated = true;
  }
  const passwordHash = hashPassword(password);

  const user = existing
    ? await prisma.user.update({ where: { email }, data: { passwordHash } })
    : await prisma.user.create({ data: { email, name, passwordHash } });

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    reset: Boolean(existing),
    ...(generated ? { generatedPassword: password } : {}),
  };
}
