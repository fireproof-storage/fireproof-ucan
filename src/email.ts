export async function send({
	postmarkToken,
	recipient,
	sender,
	senderName,
	template,
	templateData,
	postmarkappUrl
}: {
	postmarkToken: string;
	recipient: string;
	sender?: string;
	senderName?: string;
	template: string;
	templateData: Record<string, any>;
	postmarkappUrl?: string
}) {
	const email = sender || 'no-reply@fireproof.storage';
	const rsp = await fetch(postmarkappUrl || 'https://api.postmarkapp.com/email/withTemplate', {
		method: 'POST',
		headers: {
			Accept: 'text/json',
			'Content-Type': 'text/json',
			'X-Postmark-Server-Token': postmarkToken,
		},
		body: JSON.stringify({
			From: `${senderName || 'Fireproof'} <${email}>`,
			To: recipient,
			TemplateAlias: template,
			TemplateModel: templateData,
		}),
	});

	if (!rsp.ok) {
		throw new Error(`Send email failed with status: ${rsp.status}, body: ${await rsp.text()}`);
	}
}
