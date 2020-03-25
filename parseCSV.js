class Parser {
  constructor(text) {
    this.text = text.replace(/\r/g, "");
    this.index = 0;
    this.rows = [[]];
  }

  parseQuoted() {
    let str = "";
    this.index++;
    while (this.index < this.text.length) {
      let c = this.text[this.index];
      let next = this.text[this.index + 1];
      if (c == '"') {
        if (next == '"') {
          str += '"';
          this.index += 2;
        } else {
          this.index++;
          break;
        }
      } else {
        str += c;
        this.index++;
      }
    }

    if (/^[0-9][0-9.]*$/.test(str)) {
      this.rows[this.rows.length - 1].push(parseFloat(str));
    } else {
      this.rows[this.rows.length - 1].push(str);
    }
  }

  parseUnquoted() {
    let str = "";
    while (this.index < this.text.length) {
      let c = this.text[this.index];
      let next = this.text[this.index + 1];
      if (c == "," || c == "\n") {
        break;
      } else {
        str += c;
        this.index++;
      }
    }
    this.rows[this.rows.length - 1].push(str);
  }

  parse() {
    while (this.index < this.text.length) {
      let c = this.text[this.index];
      if (c == '"') {
        this.parseQuoted();
      } else {
        this.parseUnquoted();
      }

      if (this.index >= this.text.length) {
        break;
      }

      if (this.text[this.index] == "\n") {
        if (this.rows.length > 0) {
          let lastRow = this.rows.length - 1;
          if (this.rows[0].length != this.rows[lastRow].length) {
            throw new Error(`Bad number of columns in row ${lastRow}: ${this.rows[lastRow].length}`);
          }
        }
        this.rows.push([]);
      }
      this.index++;
    }

    let headers = this.rows[0];
    return this.rows.slice(1, -1).map(r => r.reduce((acc,c,i) => {
      acc[headers[i]] = c;
      return acc;
    }, {}));
  }
}

export function parseCSV(text) {
  let parser = new Parser(text);
  return parser.parse();
};