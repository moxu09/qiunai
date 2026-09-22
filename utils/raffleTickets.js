function splitRaffleTickets({ totalAmount, totalTickets, amountPerTicket }) {
  const tickets = Math.max(0, Math.trunc(Number(totalTickets) || 0));
  const threshold = Math.max(1, Math.trunc(Number(amountPerTicket) || 1000));
  const customerTickets = Math.min(
    tickets,
    Math.max(0, Math.floor((Number(totalAmount) || 0) / threshold)),
  );
  return {
    customerTickets,
    staffTickets: Math.max(0, tickets - customerTickets),
    totalTickets: tickets,
  };
}

async function getLatestRaffleTicketSummary(supabase, userId) {
  const { data: raffle, error: raffleError } = await supabase
    .from("raffles")
    .select("id,title,start_at,end_at,amount_per_ticket,status")
    .order("start_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (raffleError) throw raffleError;
  if (!raffle) {
    return {
      raffle: null,
      customerTickets: 0,
      staffTickets: 0,
      totalTickets: 0,
    };
  }

  const { data: spending, error: spendingError } = await supabase
    .from("raffle_spending")
    .select("total_amount,tickets")
    .eq("raffle_id", raffle.id)
    .eq("user_id", String(userId))
    .maybeSingle();
  if (spendingError) throw spendingError;

  return {
    raffle,
    ...splitRaffleTickets({
      totalAmount: spending?.total_amount,
      totalTickets: spending?.tickets,
      amountPerTicket: raffle.amount_per_ticket,
    }),
  };
}

module.exports = {
  getLatestRaffleTicketSummary,
  splitRaffleTickets,
};
