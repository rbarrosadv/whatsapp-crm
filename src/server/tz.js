// O servidor calcula prazos, horários de aviso e "hoje" pelo relógio local.
// Na nuvem (Oracle) o relógio do sistema não está no horário de Brasília: o
// "vence às 23:59" virava 19:59 e o prazo interno das 18h virava 14h. Este
// arquivo é importado antes de tudo no servidor (CRM_TZ troca, se precisar).
process.env.TZ = process.env.CRM_TZ || 'America/Sao_Paulo';
