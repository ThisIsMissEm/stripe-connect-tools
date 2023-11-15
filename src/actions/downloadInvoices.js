import { createWriteStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { join as joinPath } from "node:path";
import { mkdirp } from "fs-extra";

export default async function downloadInvoices(
  stripe,
  accountName,
  period,
  config
) {
  const promises = [];

  // Ensure the output directory exists:
  const downloadsDir = joinPath(config.output.directory, "downloads");
  await mkdirp(downloadsDir);

  for await (const invoice of stripe.invoices.list({
    created: {
      gte: period.start.valueOf() / 1000,
      lt: period.end.valueOf() / 1000,
    },
    expand: ["data.customer", "data.charge"],
    status: "paid",
  })) {
    // fr-CA produces YYYY-MM-DD format dates:
    const formattedDate = Intl.DateTimeFormat("fr-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(invoice.created * 1000));

    // Because Ko-fi doesn't collect the darn customer's country:
    const country =
      invoice.customer_address?.country ||
      invoice.charge?.billing_details?.address?.country ||
      invoice.charge?.payment_method_details?.card?.country;

    const invoiceUrl = invoice.invoice_pdf;
    const invoiceFilename = `${formattedDate}-${accountName}-INVOICE-${invoice.number}.pdf`;

    const invoicePdf = await fetch(invoiceUrl, { redirect: "follow" });

    if (
      !invoicePdf.ok ||
      !invoicePdf.body ||
      invoicePdf.headers.get("Content-Type") !== "application/octet-stream"
    ) {
      console.error(`Could not download invoice PDF: ${invoice.id}`);
      console.error(invoicePdf);

      continue;
    }

    const destination = joinPath(downloadsDir, invoiceFilename);

    if (existsSync(destination)) {
      console.log(
        `Skipped invoice ${invoice.number} from ${accountName}: Already downloaded`
      );
      continue;
    } else {
      console.log(
        `Downloading invoice ${invoice.number} from ${accountName}...`
      );
    }

    const fileStream = createWriteStream(destination, { flags: "wx" });
    // @ts-ignore
    promises.push(finished(Readable.fromWeb(invoicePdf.body).pipe(fileStream)));
  }

  await Promise.allSettled(promises);
}
