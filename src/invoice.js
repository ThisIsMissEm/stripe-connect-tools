import PDFDocument from "pdfkit";
import defaults from "lodash.defaults";
import { getStreamAsBuffer } from "get-stream";

// Notice: This code was originally based on that of the npm package
// MicroInvoice (MIT Licensed), however, I found it didn't seem to work anymore,
// and required customizations for my use case.

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
        document: {
          marginLeft: 30,
          marginRight: 30,
          marginTop: 30,
          size: "A4",
        },

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
            position: 490,
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
      size: this.options.size,
    });

    this.storage = {
      header: {
        image: null,
      },
      cursor: {
        x: 0,
        y: 0,
      },
      customer: {
        height: 0,
      },
      seller: {
        height: 0,
      },
    };
  }

  /**
   * Load custom fonts
   *
   * @private
   * @return void
   */
  loadCustomFonts() {
    // Register custom fonts
    if (this.options.style.fonts.normal.path) {
      this.document.registerFont(
        this.options.style.fonts.normal.name,
        this.options.style.fonts.normal.path
      );
    }

    if (this.options.style.fonts.bold.path) {
      this.document.registerFont(
        this.options.style.fonts.bold.name,
        this.options.style.fonts.bold.path
      );
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

    // Add an image to the header if any
    // if (
    //   this.options.style.header.image &&
    //   this.options.style.header.image.path
    // ) {
    //   this.document.image(
    //     this.options.style.header.image.path,
    //     this.options.style.document.marginLeft,
    //     this.options.style.document.marginTop,
    //     {
    //       width: this.options.style.header.image.width,
    //       height: this.options.style.header.image.height,
    //     }
    //   );
    // }

    // Write header details
    this.setCursor("x", this.options.style.document.marginLeft);
    this.setCursor("y", this.options.style.document.marginTop);

    this.setText(this.options.data.invoice.name, {
      fontSize: "title",
      fontWeight: "bold",
      color: this.options.style.header.regularColor,
    });

    this.setCursor("x", this.options.style.header.textPosition);
    this.setCursor("y", this.options.style.document.marginTop);

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
  }

  /**
   * Generates customer and seller
   *
   * @private
   * @return void
   */
  generateDetails(type) {
    let _maxWidth = 250;
    let _fontMargin = 4;

    this.setCursor("y", this.options.style.header.height + 18);

    // Use a different left position
    if (type === "customer") {
      this.setCursor("x", this.options.style.document.marginLeft);
    } else {
      this.setCursor("x", this.options.style.header.textPosition);
    }

    this.options.data.invoice[type].forEach((line) => {
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

    this.storage[type].height = this.storage.cursor.y;
  }

  /**
   * Generates a row
   *
   * @private
   * @param  {string} type
   * @param  {array} columns
   * @return void
   */
  generateTableRow(type, columns) {
    let _fontWeight = "normal",
      _colorCode = "secondary";

    this.storage.cursor.y = this.document.y;

    this.storage.cursor.y += 17;

    if (type === "header") {
      _fontWeight = "bold";
      _colorCode = "primary";
    }

    let _start = this.options.style.document.marginLeft;
    let _maxY = this.storage.cursor.y;
    let currentY = this.storage.cursor.y;
    let extraY = 0;

    // Computes columns by giving an extra space for the last column \
    //   It is used to keep a perfect alignement
    let _maxWidth =
      (this.options.style.header.textPosition -
        _start -
        this.options.style.document.marginRight) /
      (columns.length - 2);

    columns.forEach((column, index) => {
      let _value;

      this.setCursor("Y", currentY);

      if (index === 0) {
        this.setCursor("x", _start);
      } else if (index == 1) {
        _maxWidth = this.options.style.table.quantity.maxWidth;
        this.setCursor("x", this.options.style.table.quantity.position);
      } else {
        _maxWidth = this.options.style.table.total.maxWidth;
        this.setCursor("x", this.options.style.table.total.position);
      }

      _value = column.value;

      if (column.price === true) {
        _value = this.prettyPrice(_value);
      }

      this.setText(_value, {
        colorCode: "primary",
        maxWidth: _maxWidth,
        fontWeight: _fontWeight,
        skipDown: true,
      });

      if (!!column.subtext) {
        const prevY = this.storage.cursor.y;
        this.storage.cursor.y += this.options.style.text.regularSize * 1.25;
        this.setText(column.subtext, {
          colorCode: "secondary",
          maxWidth: _maxWidth,
          fontWeight: _fontWeight,
          skipDown: true,
        });

        extraY = this.storage.cursor.y - prevY;

        this.storage.cursor.y = prevY;
      }

      _start += _maxWidth + 10;

      // Increase y position in case of a line return
      if (this.document.y >= _maxY) {
        _maxY = this.document.y;
      }
    });

    // Set y to the max y position
    this.setCursor("y", _maxY + extraY);

    // if (type === "header") {
    this.generateLine();
    // }
  }

  /**
   * Generates a line separator
   *
   * @private
   * @return void
   */
  generateLine() {
    this.storage.cursor.y += this.options.style.text.regularSize / 2 + 2;

    this.document
      .strokeColor("#F0F0F0")
      .lineWidth(1)
      .moveTo(this.options.style.document.marginRight, this.storage.cursor.y)
      .lineTo(
        this.document.page.width - this.options.style.document.marginRight,
        this.storage.cursor.y
      )
      .stroke();

    this.storage.cursor.y += this.options.style.text.regularSize / 2;
  }

  /**
   * Generates invoice parts
   *
   * @private
   * @return void
   */
  generateLineItems(lineItems) {
    let _startY = Math.max(
      this.storage.customer.height,
      this.storage.seller.height
    );

    let _fontMargin = 4;
    let _leftMargin = 15;

    this.setCursor("y", _startY);

    this.setText("\n\n");

    this.generateTableRow("header", this.options.data.invoice.details.header);

    lineItems.forEach((lineItem) => {
      this.generateTableRow("row", lineItem);
    });

    this.storage.cursor.y += this.options.style.text.regularSize / 2;
  }

  generateTotals(totals) {
    totals.forEach((total) => {
      let _value = total.value;

      this.setCursor("x", this.options.style.table.quantity.position);
      this.setText(total.label, {
        colorCode: "primary",
        fontWeight: "bold",
        marginTop: 12,
        maxWidth: this.options.style.table.quantity.maxWidth,
        skipDown: true,
      });

      this.setCursor("x", this.options.style.table.total.position);

      if (total.price === true) {
        _value = this.prettyPrice(total.value);
      }

      this.setText(_value, {
        colorCode: "primary",
        fontWeight: "bold",
        maxWidth: this.options.style.table.total.maxWidth,
      });
    });
  }

  /**
   * Generates legal terms
   *
   * @private
   * @return void
   */
  generateLegal(legal) {
    this.storage.cursor.y += 60;

    legal.forEach((legal) => {
      this.setCursor("x", this.options.style.document.marginLeft);

      this.setText(legal.value, {
        fontWeight: legal.weight,
        colorCode: legal.color || "primary",
        align: "left",
        marginTop: 10,
      });
    });
  }

  /**
   * Moves the internal cursor
   *
   * @private
   * @param  {string} axis
   * @param  {number} value
   * @return void
   */
  setCursor(axis, value) {
    this.storage.cursor[axis] = value;
  }

  /**
   * Convert numbers to fixed value and adds currency
   *
   * @private
   * @param  {string | number} value
   * @return string
   */
  prettyPrice(value) {
    if (typeof value === "number") {
      value = (value / 100).toFixed(2);
    }

    if (this.options.data.invoice.currency) {
      value = `${value} ${this.options.data.invoice.currency}`;
    }

    return value;
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
    let _fontSizeValue = 0;

    this.storage.cursor.y += _marginTop;

    if (!_color) {
      if (_colorCode === "primary") {
        this.document.fillColor(this.options.style.text.primaryColor);
      } else {
        this.document.fillColor(this.options.style.text.secondaryColor);
      }
    }

    if (_fontSize === "heading") {
      _fontSizeValue = this.options.style.text.headingSize;
    } else if (_fontSize === "title") {
      _fontSizeValue = this.options.style.text.titleSize;
    } else {
      _fontSizeValue = this.options.style.text.regularSize;
    }

    this.document.font(this.getFontOrFallback(_fontWeight));

    this.document.fillColor(_color);
    this.document.fontSize(_fontSizeValue);

    this.document.text(
      this.valueOrTransliterate(text),
      this.storage.cursor.x,
      this.storage.cursor.y,
      {
        align: _textAlign,
        width: _maxWidth,
        // Increase the character spacing slightly for better legibility:
        characterSpacing: 0.1,
      }
    );

    let _diff = this.document.y - this.storage.cursor.y;

    this.storage.cursor.y = this.document.y;

    // Do not move down
    if (options.skipDown === true) {
      if (_diff > 0) {
        this.storage.cursor.y -= _diff;
      } else {
        this.storage.cursor.y -= 11.5;
      }
    }
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
    this.generateDetails("customer");
    this.generateDetails("seller");
    this.generateLineItems(lineItems);
    this.generateTotals(totals);
    this.generateLegal(legal ?? []);

    const stream = getStreamAsBuffer(this.document);

    this.document.end();

    return stream;
  }
}
