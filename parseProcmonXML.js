export function parseProcmonXML(text) {
  let parser = new DOMParser();
  let doc = parser.parseFromString(text, "text/xml");
  let eventlist = doc.querySelector("procmon > eventlist");
  let result = [];
  for (let event of eventlist.children) {
    let eventObj = {};
    for (let prop of event.children) {
      if (prop.tagName == "stack") {
        eventObj.stack = [];
        for (let frame of prop.children) {
          let location = frame.querySelector("location");
          let path = frame.querySelector("path");
          let frameObj = {
            location: location ? location.textContent : "<unsymbolicated>",
            path: path ? path.textContent : "",
          };
          eventObj.stack.push(frameObj);
        }
      } else {
        let str = prop.textContent;
        if (/^[0-9][0-9.]*$/.test(str)) {
          eventObj[prop.tagName.replace(/_/g, " ")] = parseFloat(str);
        } else {
          eventObj[prop.tagName.replace(/_/g, " ")] = str;
        }
      }
    }

    result.push(eventObj);
  }

  return result;
};