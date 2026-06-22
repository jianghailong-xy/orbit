import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hashPassword, verifyPassword } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedException('invalid credentials');
    }
    return this.tokenFor(user.id, user.email, user.name);
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    // Wrong current password returns 400, not 401: the web client treats any 401 as an
    // expired session and force-logs-out, which must not happen while filling this form.
    if (!user || !verifyPassword(currentPassword, user.passwordHash)) {
      throw new BadRequestException('current password is incorrect');
    }
    if (verifyPassword(newPassword, user.passwordHash)) {
      throw new BadRequestException('new password must be different from the current password');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: hashPassword(newPassword) },
    });
    return { success: true };
  }

  private async tokenFor(userId: string, email: string, name: string) {
    const accessToken = await this.jwt.signAsync({ sub: userId, email });
    return { accessToken, user: { id: userId, email, name } };
  }
}
