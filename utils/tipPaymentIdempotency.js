function matchesTipPaymentNote(storedNote, expectedNote) {
  if (storedNote === expectedNote) return true;
  try {
    const metadata = JSON.parse(String(storedNote || ""));
    return metadata?.originalNote === expectedNote;
  } catch {
    return false;
  }
}

module.exports = { matchesTipPaymentNote };
