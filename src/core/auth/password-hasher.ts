export class PasswordHasher {
  async hash(password: string): Promise<string> {
    return await Bun.password.hash(password, {
      algorithm: 'argon2id',
    });
  }

  async verify(password: string, passwordHash: string): Promise<boolean> {
    return await Bun.password.verify(password, passwordHash);
  }
}
