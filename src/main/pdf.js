// Recibo em PDF gerado no servidor (pdfkit), com a imagem da assinatura e,
// opcionalmente, assinatura digital ICP-Brasil (CMS destacado, adbe.pkcs7.detached):
// - A1 (.pfx/.p12 guardado no servidor): `signPdfA1`, tudo aqui;
// - A3 (token/cartão no computador de quem emite): `externalSign` prepara o
//   PDF e devolve os bytes a assinar; o app de desktop assina no Windows (pede
//   o PIN do token) e devolve o CMS, que `finish` encaixa no PDF.
import fs from 'node:fs';
import PDFDocument from 'pdfkit';
import forge from 'node-forge';
import { SignPdf } from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import { plainAddPlaceholder } from '@signpdf/placeholder-plain';
import { Signer } from '@signpdf/utils';

const money = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const METHODS = { pix: 'Pix', dinheiro: 'dinheiro', transferencia: 'transferência bancária', boleto: 'boleto', cartao: 'cartão', cheque: 'cheque' };

/** Lê o certificado A1 (confere a senha) e devolve quem é, emissor e validade. */
export function certInfo(p12Buffer, password) {
  let p12;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12Buffer.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch (e) {
    throw new Error(/password|MAC|Invalid/i.test(e.message) ? 'Senha do certificado incorreta.' : 'Arquivo de certificado inválido (use o .pfx ou .p12 do certificado A1).');
  }
  const bags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  const keys = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [];
  if (!keys.length) throw new Error('O arquivo não tem a chave do certificado (exporte com a chave privada).');
  // o certificado da pessoa/empresa é o que não é de autoridade (sem basicConstraints cA)
  const cert = bags.map((b) => b.cert).find((c) => !c.getExtension('basicConstraints')?.cA) || bags[0]?.cert;
  if (!cert) throw new Error('Certificado não encontrado no arquivo.');
  const field = (attrs, sn) => attrs.getField(sn)?.value || '';
  return {
    name: field(cert.subject, 'CN').split(':')[0].trim(),
    issuer: field(cert.issuer, 'CN') || field(cert.issuer, 'O'),
    validFrom: cert.validity.notBefore.getTime(),
    validTo: cert.validity.notAfter.getTime(),
  };
}

function render(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/**
 * @param {{no:number, value:number, words:string, at:number, method?:string, who:string, doc?:string, ref:string,
 *   office:{name:string, doc?:string, address?:string, city?:string}, logo?:string, signatureImage?:string,
 *   signerName?:string, signedBy?:{name?:string, issuer?:string}}} r
 * Devolve o PDF sem assinatura digital; `signedBy` só escreve o aviso no rodapé.
 */
export async function receiptPdf(r) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 60, bottom: 60, left: 64, right: 64 },
    info: { Title: `Recibo nº ${String(r.no).padStart(4, '0')}`, Author: r.office.name, Creator: 'Barros Associados — sistema' } });
  const W = doc.page.width - 128;
  const ink = '#111111';
  const brand = '#3d5a6c';
  const top = doc.y;
  if (r.logo && fs.existsSync(r.logo)) {
    try { doc.image(r.logo, 64, top, { height: 54 }); } catch { /* logo ilegível: segue sem */ }
  }
  doc.font('Times-Bold').fontSize(11).fillColor(ink).text(r.office.name, 64, top, { width: W, align: 'right' });
  doc.font('Times-Roman').fontSize(9.5).fillColor('#444444');
  for (const l of [r.office.doc, r.office.address].filter(Boolean)) doc.text(l, { width: W, align: 'right' });
  const lineY = Math.max(doc.y, top + 58) + 8;
  doc.moveTo(64, lineY).lineTo(64 + W, lineY).lineWidth(1.6).strokeColor(brand).stroke();

  doc.y = lineY + 30;
  doc.font('Times-Bold').fontSize(22).fillColor(ink).text('RECIBO', 64, doc.y, { width: W, align: 'center', characterSpacing: 3 });
  doc.font('Times-Roman').fontSize(11).fillColor('#555555').text(`Nº ${String(r.no).padStart(4, '0')}`, { width: W, align: 'center' });

  // valor em destaque
  const box = money(r.value);
  doc.font('Times-Bold').fontSize(17);
  const bw = doc.widthOfString(box) + 44;
  const by = doc.y + 18;
  doc.roundedRect(64 + (W - bw) / 2, by, bw, 34, 5).lineWidth(1.6).strokeColor(brand).stroke();
  doc.fillColor(ink).text(box, 64, by + 9, { width: W, align: 'center' });

  doc.y = by + 60;
  doc.font('Times-Roman').fontSize(13).fillColor(ink);
  doc.text('Recebemos de ', 64, doc.y, { continued: true, width: W, align: 'justify', lineGap: 4 })
    .font('Times-Bold').text(r.who, { continued: true })
    .font('Times-Roman').text(`${r.doc ? `, ${r.doc}` : ''}, a importância de `, { continued: true })
    .font('Times-Bold').text(box, { continued: true })
    .font('Times-Roman').text(` (${r.words}), referente a ${r.ref}${r.method ? `, paga em ${METHODS[r.method] || r.method}` : ''}.`);
  doc.moveDown(0.8);
  doc.text('Para clareza, firmamos o presente recibo, dando plena quitação do valor acima.', { width: W, align: 'justify', lineGap: 4 });
  doc.moveDown(1.2);
  const date = new Date(r.at).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
  doc.text(`${r.office.city || 'Cuiabá-MT'}, ${date}.`, { width: W, align: 'right' });

  // assinatura: imagem (se houver) sobre a linha
  let sy = doc.y + 40;
  if (r.signatureImage && fs.existsSync(r.signatureImage)) {
    try {
      doc.image(r.signatureImage, 64 + W / 2 - 90, sy, { fit: [180, 64], align: 'center', valign: 'bottom' });
      sy += 66;
    } catch { sy += 30; }
  } else sy += 30;
  doc.moveTo(64 + W * 0.2, sy).lineTo(64 + W * 0.8, sy).lineWidth(0.8).strokeColor(ink).stroke();
  doc.font('Times-Roman').fontSize(11.5).fillColor(ink).text(r.signerName || r.office.name, 64, sy + 6, { width: W, align: 'center' });
  if (r.signerName && r.signerName !== r.office.name) doc.fontSize(10).fillColor('#555555').text(r.office.name, { width: W, align: 'center' });
  if (r.office.doc) doc.fontSize(10).fillColor('#555555').text(r.office.doc, { width: W, align: 'center' });
  if (r.signedBy) {
    const info = r.signedBy;
    doc.moveDown(2).fontSize(9).fillColor('#3d5a6c')
      .text(`Documento assinado digitalmente por ${info.name || 'certificado ICP-Brasil'}${info.issuer ? ` (${info.issuer})` : ''}. `
        + 'Confira a assinatura em validar.iti.gov.br.', 64, doc.y, { width: W, align: 'center' });
  }
  return render(doc);
}

const placeholder = (pdf, { reason = '', location = '', name = '' } = {}) =>
  plainAddPlaceholder({ pdfBuffer: pdf, reason, location, name, contactInfo: '', signatureLength: 16384 });

/** Assina o PDF com o certificado A1 (arquivo + senha), no servidor. */
export async function signPdfA1(pdf, { p12, password }, meta = {}) {
  const signer = new P12Signer(p12, { passphrase: password });
  return Buffer.from(await new SignPdf().sign(placeholder(pdf, meta), signer));
}

/** Assinatura feita fora (certificado A3 no computador de quem emite). */
class ExternalSigner extends Signer {
  constructor() {
    super();
    this.data = new Promise((resolve) => { this.giveData = resolve; });
    this.cms = new Promise((resolve, reject) => { this.giveCms = resolve; this.fail = reject; });
  }

  async sign(content) {
    this.giveData(content);
    return this.cms;
  }
}

/**
 * 1ª metade da assinatura com A3: devolve `data` (o que o certificado assina:
 * o PDF sem o espaço da assinatura) e `finish(cms)`, que devolve o PDF assinado.
 */
export async function externalSign(pdf, meta = {}) {
  const signer = new ExternalSigner();
  const signed = new SignPdf().sign(placeholder(pdf, meta), signer);
  signed.catch(() => {});
  const data = await Promise.race([signer.data, signed.then(() => { throw new Error('assinatura inesperada'); })]);
  return {
    data: Buffer.from(data),
    finish: async (cms) => {
      const der = Buffer.isBuffer(cms) ? cms : Buffer.from(cms);
      if (der.length < 200 || der[0] !== 0x30) throw new Error('A assinatura devolvida pelo certificado é inválida.');
      if (der.length > 16384) throw new Error('A assinatura ficou grande demais para o espaço reservado no PDF.');
      signer.giveCms(der);
      return Buffer.from(await signed);
    },
    cancel: () => signer.fail(new Error('cancelada')),
  };
}
