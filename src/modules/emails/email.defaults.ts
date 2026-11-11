import type { TemplateKey } from "./email.models";

export const DEFAULT_TEMPLATES: { key: TemplateKey; name: string; subjectEn: string; subjectEs: string; bodyEn: string; bodyEs: string }[] = [
  {
    key: "E1", name: "VIP welcome",
    subjectEn: "Welcome to the GRYSOSTA VIP Priority List, {first_name}!",
    subjectEs: "¡Bienvenido a la Lista VIP Prioritaria de GRYSOSTA, {first_name}!",
    bodyEn: "Hi {first_name},\n\nYou're officially on the VIP Priority List for The Beginner's Guide to Stock Trading by Georgino Perez.\n\nAs a VIP member you will:\n• Be the first to know when the manual is ready\n• Get an exclusive 10% discount: {vip_price} instead of {price}\n\nSimple Knowledge. Brighter Opportunities!\nGeorgino Perez, Founder, GRYSOSTA Stock Trading Academy",
    bodyEs: "Hola {first_name}:\n\nUsted ya forma parte de la Lista VIP Prioritaria de La Guía para Principiantes del Trading de Acciones, de Georgino Perez.\n\nComo miembro VIP usted:\n• Será el primero en saber cuándo el manual esté listo\n• Obtendrá un descuento exclusivo del 10%: {vip_price} en lugar de {price}\n\n¡Conocimiento simple. Oportunidades más brillantes!\nGeorgino Perez, Fundador, GRYSOSTA Stock Trading Academy",
  },
  {
    key: "E2", name: "VIP + referrer welcome",
    subjectEn: "{first_name}, here is your referral code and link",
    subjectEs: "{first_name}, aquí está su código y enlace de referido",
    bodyEn: "Hi {first_name},\n\nWelcome to the GRYSOSTA referral program!\n\nYour referral code: {code}\nYour referral link: {referral_link}\n\nHow it works:\n1. Share your link with friends, family and your network.\n2. When someone buys the manual through your link, you earn {commission_amount}.\n3. Commissions are confirmed after 30 days.\n\nTrack your results anytime: {my_referrals_link}\n\nRemember: when you share, say you earn a commission (#ad).",
    bodyEs: "Hola {first_name}:\n\n¡Bienvenido al programa de referidos de GRYSOSTA!\n\nSu código de referido: {code}\nSu enlace de referido: {referral_link}\n\nCómo funciona:\n1. Comparta su enlace con amigos, familiares y su red.\n2. Cuando alguien compra el manual con su enlace, usted gana {commission_amount}.\n3. Las comisiones se confirman después de 30 días.\n\nConsulte sus resultados en cualquier momento: {my_referrals_link}\n\nRecuerde: al compartir, indique que gana una comisión (#ad).",
  },
  {
    key: "E3", name: "Announcement",
    subjectEn: "News from GRYSOSTA: {announcement_title}",
    subjectEs: "Novedades de GRYSOSTA: {announcement_title}",
    bodyEn: "Hi {first_name},\n\n{announcement_body}\n\n[Visit grysosta.com]",
    bodyEs: "Hola {first_name}:\n\n{announcement_body}\n\n[Visitar grysosta.com]",
  },
  {
    key: "E4", name: "Launch email",
    subjectEn: "It's here! Your VIP price of {vip_price} is ready, {first_name}",
    subjectEs: "¡Ya llegó! Su precio VIP de {vip_price} está listo, {first_name}",
    bodyEn: "Hi {first_name},\n\nThe wait is over. The Beginner's Guide to Stock Trading is now available.\n\nPrepay today and save 10%: {vip_price} instead of {price}.\nPrepay customers get first shipping priority.\n\n[PREPAY NOW]\n\nSimple Knowledge. Brighter Opportunities!\nGeorgino Perez, Founder, GRYSOSTA Stock Trading Academy",
    bodyEs: "Hola {first_name}:\n\nLa espera terminó. La Guía para Principiantes del Trading de Acciones ya está disponible.\n\nCompre hoy con descuento del 10%: {vip_price} en lugar de {price}.\nQuienes compran por adelantado reciben prioridad de envío.\n\n[COMPRAR AHORA]\n\n¡Conocimiento simple. Oportunidades más brillantes!\nGeorgino Perez, Fundador, GRYSOSTA Stock Trading Academy",
  },
  {
    key: "E5", name: "Referrer magic link",
    subjectEn: "Your GRYSOSTA referral dashboard link",
    subjectEs: "Su enlace al panel de referidos de GRYSOSTA",
    bodyEn: "Hi {first_name},\n\nClick the button below to see your referral results. This link expires in 30 minutes.\n\n[Open my referrals]\n\nIf you didn't request this, you can ignore this email.",
    bodyEs: "Hola {first_name}:\n\nHaga clic en el botón para ver sus resultados de referidos. Este enlace vence en 30 minutos.\n\n[Abrir mis referidos]\n\nSi usted no lo solicitó, puede ignorar este correo.",
  },
  {
    key: "E6", name: "Admin daily signup summary",
    subjectEn: "GRYSOSTA daily summary: {new_signups} new VIP members",
    subjectEs: "",
    bodyEn: "Good morning,\n\nYesterday: {new_signups} new VIP members ({new_referrers} new referrers).\nTotal VIP members: {total_members}\nVisitors yesterday: {visitors}\n\nTop referrers yesterday:\n{top_referrers}\n\n[Open the admin panel]",
    bodyEs: "",
  },
  {
    key: "E7", name: "Purchase invitation",
    subjectEn: "{first_name}, your GRYSOSTA prepay invitation is ready",
    subjectEs: "{first_name}, su invitación para prepagar en GRYSOSTA está lista",
    bodyEn: "Hi {first_name},\n\nYour spot on the list is ready. The manual is nearly ready to ship.\n\nPrepay today and save 10%: {vip_price} instead of {price}.\nPrepay customers get first shipping priority.\n\n[PREPAY NOW]\n\nSimple Knowledge. Brighter Opportunities!\nGeorgino Perez, Founder, GRYSOSTA Stock Trading Academy",
    bodyEs: "Hola {first_name}:\n\nSu lugar en la lista está listo. El manual está casi listo para enviarse.\n\nCompre hoy con descuento del 10%: {vip_price} en lugar de {price}.\nQuienes compran por adelantado reciben prioridad de envío.\n\n[COMPRAR AHORA]\n\n¡Conocimiento simple. Oportunidades más brillantes!\nGeorgino Perez, Fundador, GRYSOSTA Stock Trading Academy",
  },
];
