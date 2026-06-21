import nodemailer from 'nodemailer';

function createTransport(email, password) {
	return nodemailer.createTransport({
		host: 'smtp.gmail.com',
		port: 465,
		secure: true,
		auth: {
			user: email,
			pass: password,
		},
	});
}

export async function sendMail({ email, password, to, subject, body, inReplyTo, references }) {
	const transport = createTransport(email, password);
	const mailOptions = {
		from: email,
		to,
		subject,
		text: body,
		html: body.includes('<') ? body : undefined,
	};
	if (inReplyTo) mailOptions.inReplyTo = inReplyTo;
	if (references) mailOptions.references = references;

	const info = await transport.sendMail(mailOptions);
	return {
		messageId: info.messageId,
		accepted: info.accepted,
	};
}
