import { Router } from "express";
import { requireAdmin } from "./modules/auth/auth.middleware";
import { authRouter } from "./modules/auth/auth.routes";
import { publicRouter } from "./modules/public/public.routes";
import { dashboardRouter } from "./modules/dashboard/dashboard.routes";
import { settingsRouter } from "./modules/settings/settings.routes";
import { contentRouter } from "./modules/content/content.routes";
import { announcementRouter } from "./modules/announcements/announcement.routes";
import { memberRouter } from "./modules/members/member.routes";
import { etsyRouter, referrerRouter } from "./modules/referrers/referrer.routes";
import { salesRouter } from "./modules/sales/sales.routes";
import { payoutRouter } from "./modules/payouts/payout.routes";
import { emailRouter } from "./modules/emails/email.routes";
import { activityRouter, reportsRouter } from "./modules/reports/reports.routes";
import { realtimeRouter } from "./modules/realtime/realtime.routes";
import { orderRouter } from "./modules/payments/payment.routes";
import { invitationRouter } from "./modules/invitations/invitation.routes";

export const apiRouter = Router();

apiRouter.use("/public", publicRouter);
apiRouter.use("/auth", authRouter);

/* Admin panel (A2–A13) — every route checks the admin session on the server. */
const admin = Router();
admin.use(requireAdmin);
admin.use("/dashboard", dashboardRouter);         // A2
admin.use("/settings", settingsRouter);           // A3 + A12
admin.use("/announcements", announcementRouter);  // A4
admin.use("/members", memberRouter);              // A5
admin.use("/referrers", referrerRouter);          // A6
admin.use("/etsy-codes", etsyRouter);             // A7
admin.use("/sales", salesRouter);                 // A8 + commission logic
admin.use("/payouts", payoutRouter);              // A9
admin.use("/emails", emailRouter);                // A10
admin.use("/content", contentRouter);             // A11
admin.use("/reports", reportsRouter);             // A13
admin.use("/activity", activityRouter);           // A1 activity log
admin.use("/events", realtimeRouter);             // live updates for the panel (SSE)
admin.use("/orders", orderRouter);                // Prepay orders & payments (Stripe)
admin.use("/invitations", invitationRouter);      // purchase invitations, batch control
apiRouter.use("/admin", admin);
