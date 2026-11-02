import { z } from "zod";

export const loginSchema = z.object({ email: z.string().email().toLowerCase().trim(), password: z.string().min(1).max(200) });
export const verify2faSchema = z.object({ challengeToken: z.string().min(10), code: z.string().regex(/^\d{6}$/) });
export const forgotSchema = z.object({ email: z.string().email().toLowerCase().trim() });
export const resetSchema = z.object({ token: z.string().min(10), password: z.string().min(8).max(200) });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(200) });
export const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
