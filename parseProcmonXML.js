export function parseProcmonXML(text) {
  let parser = new DOMParser();
  let doc = parser.parseFromString(text, "text/xml");
  let eventlist = doc.querySelector("procmon > eventlist");
  let processlist = doc.querySelector("procmon > processlist");
  let result = [];
  let moduleMap = {};
  for (let proc of processlist.children) {
    let procId = parseInt(proc.querySelector("ProcessId").textContent);
    moduleMap[procId] = {};
    for (let mod of proc.querySelector("modulelist").children) {
      let path = mod.querySelector("Path").textContent;
      let baseAddress = BigInt(mod.querySelector("BaseAddress").textContent);
      moduleMap[procId][path] = baseAddress;
    }
  }

  for (let event of eventlist.children) {
    let eventObj = {};
    for (let prop of event.children) {
      if (prop.tagName == "stack") {
        eventObj.stack = [];
        for (let frame of prop.children) {
          let location = frame.querySelector("location");
          let path = frame.querySelector("path");
          let address = frame.querySelector("address");

          let frameObj = {
            location: location ? location.textContent : "<unsymbolicated>",
            path: path ? path.textContent : "",
            address: address ? BigInt(address.textContent) : 0,
          };

          if (eventObj["PID"] in moduleMap &&
              frameObj.path in moduleMap[eventObj["PID"]]) {
            let baseAddress = moduleMap[eventObj["PID"]][frameObj.path];
            frameObj.address = frameObj.address - baseAddress;
          }

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