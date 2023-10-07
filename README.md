# Stripe Connect Tools

This repository contains a few tools that I use to help manage my Stripe Connect accounts. It's primarily been developed to address the lack of receipts or invoices that are legally compliant in Germany from Ko-fi, but will likely work for other platforms too. In the future I may add additional reporting capaibilities, as that functionality is mostly there already (e.g., calculating all the stripe fees and platform fees).

## Configuration

This project has two main configuration files: `.env` and `config.toml`. The `.env` file contains the `STRIPE_TOKEN_$NAME` variables allowing you to pass in multiple Stripe connect accounts via the 1password CLI's `op run` function, which is used by default for `npm start`. To find the URLs you need to use `op item list --format=json --categories="API Credential"`. The `$NAME` part is used as the identifier for the account name (e.g., KOFI).

The `config.toml` file includes your business information and a few other settings.

## Creating Receipts for Ko-fi

After configuring the tool, run `npm start` and select the date period, stripe connect account, and the "Create & Save Receipts" function. This will then look at all your transactions and attempt to create a PDF receipt for the transactions/charges. You will find these in the "receipts" directory.

## Downloading Subscription Invoices

This downloads the stripe invoices that are automatically created for subscriptions, in case you need them, however, they're typically not what you need for accounting / bookkeeping purposes in germany, and only gives you insight into subscriptions, not one-off payments.

## Limitations

This tool does have limitations, in that it's been designed primarily for my own use here in Germany, and it does not currently handle certain things like refunds or payments that are not associated with a charge or a subscription. This tool is also not fully localised.
