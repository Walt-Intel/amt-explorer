/*********************************************************************
* Copyright (c) Intel Corporation 2022
* SPDX-License-Identifier: Apache-2.0
**********************************************************************/

import { AMT, IPS, CIM } from '@open-amt-cloud-toolkit/wsman-messages'
import { Methods } from '@open-amt-cloud-toolkit/wsman-messages/amt'
import { Logger, LogType, parseBody, parseXML } from './common'
import { DigestAuth } from './digestAuth'
import { SocketHandler } from './socketHandler'
import { HttpZResponseModel } from 'http-z'

// Object holder for MessageHandler class.  Holds all of the relevant information for the life cycle of a message
export class MessageObject {
  api: string
  apiCall: string
  class: string
  classObject: any
  enumerationContext?: string
  error: string[]
  jsonResponse?: any
  method?: string
  statusCode?: number
  xml?: string
  xmlResponse?: string
  userInput?: any
  constructor(msgClass?: string, msgAPI?: string, msgMethod?: string, msgXML?: string, enumerationContext?: string) {
    this.class = msgClass
    this.api = msgAPI
    this.method = msgMethod
    this.xml = msgXML
    this.enumerationContext = enumerationContext
  }
}

// Object specifying the data required to be provided to MessageHandler to create a MessageObject
export class MessageRequest {
  apiCall: string
  method: string
  xml?: string
  userInput?: any
}

export class MessageHandler {
  response: any
  socketHandler: SocketHandler
  digestAuth: DigestAuth
  amt = new AMT.Messages()
  cim = new CIM.Messages()
  ips = new IPS.Messages()
  constructor(socketHandler: SocketHandler, digestAuth: DigestAuth) {
    this.socketHandler = socketHandler
    this.digestAuth = digestAuth
  }

  // Splits the apiCall coming in on the apiCall property of a MessageRequest object
  private splitAPICall = (apiCall: string): MessageObject => {
    let messageObject = new MessageObject()
    if (apiCall.includes('_')) {
      let splitAPI = apiCall.split('_')
      messageObject.class = splitAPI[0].toString()
      messageObject.api = splitAPI[1].toString()
    } else {
      messageObject.error.push('invalid apiCall property')
    }
    return messageObject
  }

  // Creates a MessageObject from a MessageRequest object
  public createMessageObject = (request: MessageRequest): MessageObject => {
    let msgObj = new MessageObject()
    if (request.apiCall == null || request.method == null) {
      msgObj.error.push('MessageRequest missing required properties')
    } else {
      msgObj = this.splitAPICall(request.apiCall)
      msgObj.apiCall = request.apiCall
      msgObj.method = request.method
      msgObj.xml = request.xml
      msgObj.userInput = request.userInput
    }
    return msgObj
  }

  // Creates a XML formatted WSMAN message
  public createMessage = async (messageObject: MessageObject): Promise<string> => {
    return new Promise(async (resolve, reject) => {
      if (messageObject.api !== null && messageObject.class !== null && messageObject.method !== null) {
        messageObject.classObject = this.setClassObject(messageObject)
        switch (messageObject.method) {
          case CIM.Methods.PULL:
            resolve(this.createPullMessage(messageObject))
            break
          case CIM.Methods.PUT:
            resolve(this.createPutMessage(messageObject))
            break
          case CIM.Methods.GET:
            resolve(messageObject.classObject[messageObject.api].Get())
            break
          case CIM.Methods.ENUMERATE:
            resolve(messageObject.classObject[messageObject.api].Enumerate())
            break
          case AMT.Methods.READ_RECORDS:
            resolve(this.amt.AuditLog.ReadRecords())
            break
          case AMT.Methods.GET_RECORDS:
            resolve(this.amt.MessageLog.GetRecords())
            break
          case AMT.Methods.POSITION_TO_FIRST_RECORD:
            resolve(this.amt.MessageLog.PositionToFirstRecord())
            break
          case AMT.Methods.GET_UUID:
            resolve(this.amt.SetupAndConfigurationService.GetUuid())
            break
          case AMT.Methods.COMMIT_CHANGES:
            resolve(this.amt.SetupAndConfigurationService.CommitChanges())
            break
          case AMT.Methods.GET_LOW_ACCURACY_TIME_SYNCH:
            resolve(this.amt.TimeSynchronizationService.GetLowAccuracyTimeSynch())
            break
          case IPS.Methods.START_OPT_IN:
            resolve(this.ips.OptInService.StartOptIn())
            break
          case IPS.Methods.CANCEL_OPT_IN:
            resolve(this.ips.OptInService.CancelOptIn())
            break
          case AMT.Methods.ADD_ALARM:
            messageObject.userInput.StartTime = new Date(messageObject.userInput.StartTime)
            resolve(this.amt.AlarmClockService.AddAlarm(messageObject.userInput))
            break
          case AMT.Methods.SET_ADMIN_ACL_ENTRY_EX:
            const digestPassword = this.digestAuth.createDigestPassword(messageObject.userInput.Username, messageObject.userInput.DigestPassword)
            resolve(this.amt.AuthorizationService.SetAdminACLEntryEx(messageObject.userInput.Username, digestPassword))
            break
          default:
            throw new Error('unsupported method')
        }
      }
    })
  }

  // Creates an instance of a WSMAN-MESSAGES class to be used to create a WSMAN message
  private setClassObject = (messageObject: MessageObject): any => {
    switch (messageObject.class) {
      case 'AMT':
        return new AMT.Messages()
      case 'IPS':
        return new IPS.Messages()
      case 'CIM':
        return new CIM.Messages()
    }
  }

  // Handles getting the enumerationContext from AMT in order to create a PULL message
  private createPullMessage = async (messageObject: MessageObject): Promise<string> => {
    const requestResponse = await this.getPreMessage(Methods.ENUMERATE, messageObject)
    messageObject.enumerationContext = requestResponse.jsonResponse.Envelope?.Body?.EnumerateResponse?.EnumerationContext
    messageObject.classObject = this.setClassObject(messageObject)
    return (messageObject.classObject[messageObject.api].Pull(messageObject.enumerationContext))
  }

  private createPutMessage = async (messageObject: MessageObject): Promise<string> => {
    const requestResponse = await this.getPreMessage(Methods.GET, messageObject)
    const jsonResponse = this.getDataFromJSONResponse(requestResponse)
    messageObject.classObject = this.setClassObject(messageObject)
    return (messageObject.classObject[messageObject.api].Put(jsonResponse))
  }

  private getPreMessage = async (method: Methods, messageObject: MessageObject): Promise<MessageObject> => {
    const requestObject = new MessageObject(messageObject.class, messageObject.api, method)
    requestObject.xml = await this.createMessage(requestObject)
    return await this.sendMessage(requestObject)
  }

  // Sends a message to AMT based on the MessageObject provided.  Handles auth retry.
  public sendMessage = async (messageObject: MessageObject): Promise<MessageObject> => {
    return new Promise(async (resolve, reject) => {
      if (messageObject.api == null || messageObject.class == null || messageObject.method == null || messageObject.xml == null) {
        messageObject.error.push('missing required MessageObject properties')
        resolve(messageObject)
      }
      let response = await this.sendToSocket(messageObject)
      if (response.statusCode === 401) {
        response = await this.handleRetry(messageObject, response)
      }
      messageObject.xmlResponse = parseBody(response)
      messageObject.statusCode = response.statusCode
      messageObject.jsonResponse = parseXML(messageObject.xmlResponse)
      if (messageObject.jsonResponse.Envelope.Body.GetUuid_OUTPUT?.UUID) {
        messageObject.jsonResponse.Envelope.Body.GetUuid_OUTPUT.UUID = this.convertToGUID(messageObject.jsonResponse.Envelope.Body.GetUuid_OUTPUT.UUID)
        console.log(messageObject.jsonResponse.Envelope.Body.GetUuid_OUTPUT.UUID)
      }
      resolve(messageObject)
    })
  }

  convertToGUID = (base64EncodedOctetString: string): string => {
    // Convert the base64 encoded octet string to a Uint8Array
    const octets = new Uint8Array(atob(base64EncodedOctetString).split('').map(char => char.charCodeAt(0)));

    // Create a new DataView with the octets as its buffer
    const dataView = new DataView(octets.buffer);

    // Get the first four bytes and convert them to an unsigned 32-bit integer
    const data1 = dataView.getUint32(0, true);

    // Get the next two bytes and convert them to an unsigned 16-bit integer
    const data2 = dataView.getUint16(4, true);

    // Get the next two bytes and convert them to an unsigned 16-bit integer
    const data3 = dataView.getUint16(6, true);

    // Get the next 2 bytes and convert them to an unsigned 16-bit integer
    const data4_1 = dataView.getUint16(8, false);

    // Get the next 6 bytes by copy them to a new ArrayBuffer
    var data4_2 = new ArrayBuffer(6)
    var dataView2 = new DataView(data4_2);
    dataView2.setUint8(5, dataView.getUint8(10));
    dataView2.setUint8(4, dataView.getUint8(11));
    dataView2.setUint8(3, dataView.getUint8(12));
    dataView2.setUint8(2, dataView.getUint8(13));
    dataView2.setUint8(1, dataView.getUint8(14));
    dataView2.setUint8(0, dataView.getUint8(15));
    // convert the ArrayBuffer to hex string
    var hex = '';
    var bytes = new Uint8Array(data4_2);
    var length = bytes.byteLength;
    for (var i = 0; i < length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }
    // Reverse the byte order
    hex = hex.match(/.{2}/g).reverse().join('');
    // Return the formatted GUID string
    return `${data1.toString(16).padStart(8, '0')}-${data2.toString(16).padStart(4, '0')}-${data3.toString(16).padStart(4, '0')}-${data4_1.toString(16).padStart(4, '0')}-${hex}`;
}


  private getDataFromJSONResponse = (messageObject: MessageObject): object => {
    let keys: string[], jsonResponse: object
    if (messageObject.xmlResponse.includes('PullResponse')) {
      keys = Object.keys(messageObject.jsonResponse.Envelope?.Body?.PullResponse?.Items)
      keys.forEach(element => {
        jsonResponse = messageObject.jsonResponse.Envelope?.Body?.PullResponse?.Items[element][0]
      })
    } else if (messageObject.xmlResponse.includes('GetResponse')) {
      keys = Object.keys(messageObject.jsonResponse.Envelope?.Body)
      keys.forEach(element => {
        jsonResponse = messageObject.jsonResponse.Envelope?.Body[element]
      })
    }
    return jsonResponse
  }

  // performs an auth retry based on a 401 response back from AMT
  private handleRetry = async (messageObject: MessageObject, response: HttpZResponseModel): Promise<HttpZResponseModel> => {
    const authHeaders = this.digestAuth.parseAuthorizationHeader(response)
    this.digestAuth.setDigestAuthHeaders(authHeaders)
    const retry = await this.sendToSocket(messageObject)
    return retry
  }

  // Sends a message to SocketHandler.  Adds proper headers to message
  private sendToSocket = async (messageObject: MessageObject): Promise<HttpZResponseModel> => {
    const message = this.digestAuth.createMessage(messageObject.xml, this.digestAuth.getDigestAuthHeaders())
    Logger(LogType.DEBUG, 'MESSAGEHANDLER', `SENDING:\r\n${message}`)
    const response = await this.socketHandler.write(message)
    Logger(LogType.DEBUG, 'MESSAGEHANDLER', `RESPONSE:\r\n${JSON.stringify(response)}`)
    return response
  }
}