export function WhatsAppDisclaimer() {
  return (
    <p className="text-xs leading-snug text-amber-700">
      WhatsApp compatibility is not guaranteed. Some VoIP, toll-free, landline, or virtual numbers
      may be unsupported by WhatsApp/Meta. Eligibility depends on number type, country, account
      standing, and current WhatsApp/Meta policy.
    </p>
  );
}

export function InventoryDisclaimer() {
  return (
    <p className="text-xs leading-snug text-slate-600">
      This searches Twilio inventory. It does not create arbitrary PSTN numbers, spoof caller ID, or
      bypass carriers. Only numbers Twilio offers in your account region appear here.
    </p>
  );
}
