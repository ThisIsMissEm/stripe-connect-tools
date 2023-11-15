import PDFDocument from "pdfkit";
import defaults from "lodash.defaults";
import { getStreamAsBuffer } from "get-stream";

// Notice: This code was originally based on that of the npm package
// MicroInvoice (MIT Licensed), however, I found it didn't seem to work anymore,
// and required customizations for my use case.

/**
 * Convert numbers to fixed value and adds currency
 *
 * @private
 * @param  {string | number} value
 * @return string
 */
export function prettyPrice(value, currency) {
  if (typeof value === "number") {
    value = (value / 100).toFixed(2);
  }

  if (currency) {
    value = `${String(value).padStart(5, " ")} ${currency}`.trimEnd();
  }

  return String(value).padStart(5, " ");
}

/**
 * Invoice
 * This is the constructor that creates a new instance containing the needed
 * methods.
 *
 * @name Invoice
 * @function
 * @param {Object} options The options for creating the new invoice:
 */
export default class Invoice {
  constructor(options) {
    this.defaultOptions = {
      style: {
        fonts: {
          normal: {
            name: "Helvetica",
          },
          bold: {
            name: "Helvetica-Bold",
          },
        },
        header: {
          backgroundColor: "#F8F8FA",
          height: 150,
          image: null,
          textPosition: 330,
        },
        table: {
          quantity: {
            position: 330,
            maxWidth: 140,
          },
          total: {
            position: 475,
            maxWidth: 80,
          },
        },
        text: {
          primaryColor: "#000100",
          secondaryColor: "#8F8F8F",
          titleSize: 30,
          headingSize: 15,
          regularSize: 10,
        },
      },

      data: {
        invoice: {
          name: "Invoice for Acme",
          header: [
            {
              label: "Invoice Number",
              value: 1,
            },
          ],
          customer: [
            {
              label: "Bill To",
              value: [],
            },
          ],
          seller: [
            {
              label: "Bill From",
              value: [],
            },
          ],
          details: {
            header: [
              {
                value: "Description",
              },
              {
                value: "Quantity",
              },
              {
                value: "Subtotal",
              },
            ],
            parts: [],
            total: [
              {
                label: "Total",
                value: 0,
              },
            ],
          },
          legal: [],
        },
      },
    };

    this.options = defaults(options, this.defaultOptions);

    this.document = new PDFDocument({
      size: "A4",
      margin: 30,
    });

    this.storage = {
      header: {
        image: null,
      },
      customer: {
        height: 0,
      },
      seller: {
        height: 0,
      },
    };
  }

  moveTo(x, y) {
    if (x !== null) {
      this.document.x = x;
    }

    if (y !== null) {
      this.document.y = y;
    }
  }

  /**
   * Load fallback font (unicode chars)
   *
   * @private
   * @return void
   */
  getFontOrFallback(type) {
    if (type !== "normal" && type !== "bold") {
      type = "normal";
    }

    return this.options.style.fonts[type].name;
  }

  /**
   * Show value or transliterate
   *
   * @private
   * @param  {string} value
   * @return void
   */
  valueOrTransliterate(value) {
    let _fallbackRange = this.options.style.fonts.fallback?.range;

    // Return default font
    if (this.options.style.fonts.fallback?.enabled === false) {
      return value;
    }

    // Return default font if not special chars are found
    if (!_fallbackRange || !_fallbackRange.test((value || "").toString())) {
      return value;
    }

    // return transliterate(value);
    return value;
  }

  /**
   * Generates the header
   *
   * @private
   * @return void
   */
  generateHeader() {
    // Background Rectangle
    this.document
      .rect(0, 0, this.document.page.width, this.options.style.header.height)
      .fill(this.options.style.header.backgroundColor);

    this.setText(this.options.data.invoice.name, {
      fontSize: "title",
      fontWeight: "bold",
      color: this.options.style.header.regularColor,
    });

    this.moveTo(
      this.options.style.header.textPosition,
      this.document.page.margins.top
    );

    this.options.data.invoice.header.forEach((line, index) => {
      this.setText(line.label.length > 0 ? `${line.label}:` : "", {
        fontWeight: "bold",
        color: this.options.style.header.regularColor,
        marginTop: index > 0 ? 4 : 0,
      });

      let _values = [];

      if (Array.isArray(line.value)) {
        _values = line.value;
      } else {
        _values = [line.value];
      }

      _values.forEach((value) => {
        this.setText(value, {
          colorCode: "secondary",
          color: this.options.style.header.secondaryColor,
          marginTop: 4,
        });
      });
    });

    this.moveTo(
      this.document.page.margins.left,
      this.options.style.header.height + 18
    );
  }

  /**
   * Generates customer and seller
   *
   * @private
   * @return void
   */
  generateDetails(entity, type) {
    if (!entity) {
      this.moveTo(
        this.document.page.margins.left,
        this.options.style.header.height + 18
      );
      return;
    }

    let _maxWidth = 250;
    let _fontMargin = 4;

    // Use a different left position
    if (type === "customer") {
      this.moveTo(
        this.document.page.margins.left,
        this.options.style.header.height + 18
      );
    } else {
      this.moveTo(
        this.options.style.header.textPosition,
        this.options.style.header.height + 18
      );
    }

    entity.forEach((line) => {
      this.setText(line.label != " " ? `${line.label}:` : " ", {
        colorCode: "primary",
        fontWeight: "bold",
        marginTop: 8,
        maxWidth: _maxWidth,
      });

      let _values = [];

      if (Array.isArray(line.value)) {
        _values = line.value;
      } else {
        _values = [line.value];
      }

      _values.forEach((value) => {
        this.setText(value, {
          colorCode: "secondary",
          marginTop: _fontMargin,
          maxWidth: _maxWidth,
        });
      });
    });

    this.storage[type].height = this.document.y;
  }

  /**
   * Generates a row
   *
   * @private
   * @param  {string} type
   * @param  {array} columns
   * @return void
   */
  generateTableRow(type, columns, rowTop) {
    let fontWeight = "normal";

    if (type === "header") {
      fontWeight = "bold";
    }

    let start = this.document.page.margins.left;
    let maxRowHeight = 0;

    let maxWidth =
      (start + this.document.page.width - this.document.page.margins.right) /
      (columns.length - 2);

    columns.forEach((column, index) => {
      let _value;
      let align = "left";

      if (index === 0) {
        this.moveTo(start, rowTop);
      } else if (columns.length > 2 && index == 1) {
        maxWidth = this.options.style.table.quantity.maxWidth;

        this.moveTo(this.options.style.table.quantity.position, rowTop);
      } else {
        maxWidth = this.options.style.table.total.maxWidth;
        align = "right";
        this.moveTo(this.options.style.table.total.position, rowTop);
      }

      _value = column.value;

      if (column.price === true) {
        _value = prettyPrice(_value, this.options.data.invoice.currency);
      }

      this.setText(_value, {
        colorCode: type === "subitem" ? "secondary" : "primary",
        maxWidth: maxWidth,
        fontWeight: fontWeight,
        align: column.price ? "right" : align,
      });

      // Handles adding additional details to a line item (e.g., subscription period)
      if (!!column.subtext) {
        this.document.moveDown(0.5);
        this.setText(column.subtext.trim(), {
          colorCode: "secondary",
          maxWidth: maxWidth,
          fontWeight: fontWeight,
        });
      }

      if (column.subitems && column.subitems.length > 0) {
        this.document.moveDown(0.5);
        column.subitems.forEach((subitem) => {
          this.generateTableRow(
            "subitem",
            [
              {
                value: subitem.description,
              },
              {
                value: subitem.date,
              },
              {
                value: subitem.price,
                price: true,
              },
            ],
            this.document.y
          );
          this.document.moveDown(0.25);
        });
      }

      maxRowHeight = Math.max(maxRowHeight, this.document.y - rowTop);
      start += maxWidth + 10;
    });

    this.moveTo(this.document.page.margins.left, rowTop + maxRowHeight);
  }

  /**
   * Generates a line separator
   *
   * @private
   * @return void
   */
  generateLine() {
    this.document.moveDown(0.4);

    const lineY = this.document.y - 1;

    this.document
      .strokeColor("#F0F0F0")
      .lineWidth(1)
      .moveTo(this.document.page.margins.left - 10, lineY)
      .lineTo(
        this.document.page.width - this.document.page.margins.right,
        lineY
      )
      .stroke()
      .moveDown(0.6);
  }

  /**
   * Generates invoice parts
   *
   * @private
   * @return void
   */
  generateLineItems(lineItems) {
    let startY = this.options.style.header.height + 18;

    if (this.storage.customer.height > 0 || this.storage.seller.height > 0) {
      startY =
        Math.max(this.storage.customer.height, this.storage.seller.height) + 18;
    }

    this.moveTo(this.document.page.margins.left, startY);

    this.generateTableRow(
      "header",
      this.options.data.invoice.details.header,
      this.document.y
    );

    this.generateLine();

    lineItems.forEach((lineItem) => {
      this.generateTableRow("row", lineItem, this.document.y);

      this.generateLine();
    });

    this.document.moveDown(0.5);
  }

  generateTotals(totals) {
    totals.forEach((total) => {
      let _value = total.value;
      let rowTop = this.document.y + 12;

      this.moveTo(this.options.style.table.quantity.position, rowTop);
      this.setText(total.label, {
        colorCode: "primary",
        fontWeight: "bold",
        maxWidth: this.options.style.table.quantity.maxWidth,
      });

      this.moveTo(this.options.style.table.total.position, rowTop);

      if (total.price === true) {
        _value = prettyPrice(total.value, this.options.data.invoice.currency);
      }

      this.setText(_value, {
        colorCode: "primary",
        fontWeight: "bold",
        maxWidth: this.options.style.table.total.maxWidth,
        align: total.price ? "right" : "left",
      });

      this.document.moveDown();
    });
  }

  /**
   * Generates legal terms
   *
   * @private
   * @return void
   */
  generateLegal(legal) {
    this.moveTo(this.document.page.margins.left, this.document.y + 30);

    legal.forEach((legal) => {
      this.setText(legal.value, {
        fontWeight: legal.weight,
        colorCode: legal.color || "primary",
        align: "left",
        marginTop: 10,
      });
    });
  }

  /**
   * Adds text on the invoice with specified optons
   *
   * @private
   * @param  {string} text
   * @param  {object} options
   * @return void
   */
  setText(text, options = {}) {
    let _fontWeight = options.fontWeight || "normal";
    let _colorCode = options.colorCode || "primary";
    let _fontSize = options.fontSize || "regular";
    let _textAlign = options.align || "left";
    let _color = options.color || "";
    let _marginTop = options.marginTop || 0;
    let _maxWidth = options.maxWidth;
    let fontSize = 0;

    this.document.y += _marginTop;

    if (!_color) {
      if (_colorCode === "primary") {
        this.document.fillColor(this.options.style.text.primaryColor);
      } else {
        this.document.fillColor(this.options.style.text.secondaryColor);
      }
    }

    if (_fontSize === "heading") {
      fontSize = this.options.style.text.headingSize;
    } else if (_fontSize === "title") {
      fontSize = this.options.style.text.titleSize;
    } else {
      fontSize = this.options.style.text.regularSize;
    }

    this.document.font(this.getFontOrFallback(_fontWeight));

    this.document.fillColor(_color);
    this.document.fontSize(fontSize);

    const textOptions = {
      align: _textAlign,
      width: _maxWidth,
      // Increase the character spacing slightly for better legibility:
      characterSpacing: 0.05,
    };

    this.document.text(
      this.valueOrTransliterate(text),
      this.document.x,
      this.document.y,
      textOptions
    );
  }

  setCustomer(customer) {
    this.customer = customer;
    return this;
  }

  setBusiness(business) {
    this.business = business;
    return this;
  }

  /**
   * Generates a PDF invoide
   *
   * @public
   * @param  {string|object} output
   * @return Promise
   */
  generate({ lineItems, totals, legal }) {
    // this.loadCustomFonts();
    this.generateHeader();
    this.generateDetails(this.customer, "customer");
    this.generateDetails(this.business, "seller");
    this.generateLineItems(lineItems);
    this.generateTotals(totals);
    this.generateLegal(legal ?? []);

    const stream = getStreamAsBuffer(this.document);

    this.document.end();

    return stream;
  }
}
