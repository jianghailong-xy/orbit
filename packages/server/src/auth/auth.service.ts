import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hashPassword, verifyPassword } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async register(email: string, name: string, password: string) {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException('email already registered');
    const user = await this.prisma.user.create({
      data: { email, name, passwordHash: hashPassword(password) },
    });
    return this.tokenFor(user.id, user.email, user.name);
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedException('invalid credentials');
    }
    return this.tokenFor(user.id, user.email, user.name);
  }

  private async tokenFor(userId: string, email: string, name: string) {
    const accessToken = await this.jwt.signAsync({ sub: userId, email });
    return { accessToken, user: { id: userId, email, name } };
  }
}
