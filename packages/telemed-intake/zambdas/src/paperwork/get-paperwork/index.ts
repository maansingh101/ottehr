import { FhirClient } from '@zapehr/sdk';
import { APIGatewayProxyResult } from 'aws-lambda';
import {
  Appointment,
  DocumentReference,
  Location,
  Questionnaire,
  QuestionnaireResponse,
  QuestionnaireResponseItem,
} from 'fhir/r4';
import {
  AvailableLocationInformation,
  FileURLs,
  PaperworkPage,
  Secrets,
  SecretsKeys,
  ZambdaInput,
  createFhirClient,
  getAppointmentResourceById,
  getCorrectInputOption,
  getOtherOfficesForLocation,
  getPresignedURL,
  getQuestionnaireResponse,
  getRecentQuestionnaireResponse,
  getSecret,
  mapPaperworkResponseItem,
  questionnaireItemToInputType,
} from 'ottehr-utils';
import {
  TIMEZONE_EXTENSION,
  getM2MClientToken,
  getUser,
  getVideoEncounterForAppointment,
  userHasAccessToPatient,
} from '../../shared';
import { validateRequestParameters } from './validateRequestParameters';

export interface GetPaperworkInput {
  appointmentID: string; // passed for appointment visits
  secrets: Secrets | null;
  authorization: string | undefined;
}

interface PaperworkResponseWithoutResponses {
  message: string;
  appointment: {
    start: string;
    location: Omit<AvailableLocationInformation, 'closures'>;
  };
  questions: PaperworkPage[];
  paperworkCompleteOrInProgress: boolean;
}

type PaperworkResponseWithResponses = PaperworkResponseWithoutResponses & {
  paperwork: any;
  files?: FileURLs;
};

// Lifting up value to outside of the handler allows it to stay in memory across warm lambda invocations
let zapehrToken: string;
export const index = async (input: ZambdaInput): Promise<APIGatewayProxyResult> => {
  try {
    console.group('validateRequestParameters');
    const validatedParameters = validateRequestParameters(input);
    const { appointmentID, secrets, authorization } = validatedParameters;
    console.groupEnd();
    console.debug('validateRequestParameters success');

    if (!zapehrToken) {
      console.log('getting token');
      zapehrToken = await getM2MClientToken(secrets);
    } else {
      console.log('already have token');
    }

    const fhirClient = createFhirClient(zapehrToken);

    let appointment: Appointment | undefined = undefined;
    let location: Location | undefined = undefined;

    const questionnaireSearch: Questionnaire[] = await fhirClient.searchResources({
      resourceType: 'Questionnaire',
      searchParams: [
        {
          name: 'name',
          value: 'telemed',
        },
      ],
    });
    const questionnaire: Questionnaire = questionnaireSearch[0];
    if (!questionnaire.id) {
      throw new Error('Questionnaire ID is undefined');
    }
    if (!questionnaire.item) {
      questionnaire.item = [];
    }
    let paperworkPages: PaperworkPage[] = questionnaire.item
      .filter(
        (questionPage) =>
          questionPage.extension?.find(
            (extensionTemp) => extensionTemp.url === 'https://fhir.zapehr.com/r4/StructureDefinitions/hidden',
          )?.valueString !== 'true',
      )
      .map((questionPage) => {
        const page = questionPage.text;
        const items = questionPage.item || [];
        const reviewPageName = questionPage.extension?.find(
          (extensionTemp) => extensionTemp.url === 'https://fhir.zapehr.com/r4/StructureDefinitions/review-text',
        )?.valueString;

        return {
          page: page || 'Unknown',
          reviewPageName: reviewPageName,
          slug: questionPage.linkId.replace('-page', ''),
          questions: items.map((item) => questionnaireItemToInputType(item)),
        };
      });

    // paperworkComplete means the paperwork has been completed
    let paperworkComplete = false;
    // paperworkFilledOutForAppointment means the paperwork has been filled out for this
    // appointment -- it does not mean the paperwork has been completed
    let paperworkFilledOutForAppointment = false;
    let questionnaireResponseResource: QuestionnaireResponse | undefined = undefined;
    let appointmentPatient = undefined;

    // only prebooked appointments will have an appointment id
    console.log(`getting appointment resource for id ${appointmentID}`);
    appointment = await getAppointmentResourceById(appointmentID, fhirClient);
    if (!appointment) {
      console.log('Appointment is not found');
      return {
        statusCode: 404,
        body: JSON.stringify({ message: 'Appointment is not found' }),
      };
    }
    const locationId = appointment.participant
      .find((appt) => appt.actor?.reference?.startsWith('Location/'))
      ?.actor?.reference?.replace('Location/', '');
    if (!appointment.start) {
      throw new Error('Error getting appointment start time');
    }
    appointmentPatient = appointment.participant
      .find((appt) => appt.actor?.reference?.startsWith('Patient/'))
      ?.actor?.reference?.replace('Patient/', '');
    if (!appointmentPatient) {
      throw new Error('appointmentPatient is not defined');
    }
    if (locationId) {
      console.log(`getting location resource where id is ${locationId}`);
      location = (await fhirClient.readResource({ resourceType: 'Location', resourceId: locationId })) as Location;
    }

    const encounter = await getVideoEncounterForAppointment(appointment.id || 'Unknown', fhirClient);
    if (!encounter || !encounter.id) {
      throw new Error('Encounter ID is undefined');
    }

    console.log(
      `Getting a QuestionnaireResponse for appointment ${appointmentID} questionnaire ${questionnaire.id} encounter ${encounter.id}`,
    );
    questionnaireResponseResource = await getQuestionnaireResponse(questionnaire.id, encounter.id, fhirClient);
    if (questionnaireResponseResource) {
      paperworkFilledOutForAppointment = true;
    }

    // If it's a search by patient ID, it is for a new appointment so we should
    // not return consent information pre-checked
    const responseItemsNotToPrefill: string[] = ['patient-point-of-discovery', 'reason-for-visit'];
    if (!paperworkFilledOutForAppointment) {
      responseItemsNotToPrefill.push(
        ...[
          'consent-form-signer-relationship',
          'consent-to-treat',
          'full-name',
          'hipaa-acknowledgement',
          'signature',
          'vitals-temperature',
          'vitals-pulse',
          'vitals-hr',
          'vitals-rr',
          'vitals-bp',
        ],
      );
    }

    let responses: any = {};
    if (questionnaireResponseResource && questionnaireResponseResource.item) {
      responses = await updateQuestionnaireResponseItems(questionnaireResponseResource.item, responseItemsNotToPrefill);
      paperworkComplete =
        questionnaireResponseResource.status === 'completed' || questionnaireResponseResource.status === 'amended';
    }

    console.log('checking user authorization');
    // Do not return paperwork information if user is not logged in
    if (!authorization) {
      console.log('User is not authorized');
      const response = getPaperworkForUserWithoutAccess(
        paperworkComplete,
        paperworkFilledOutForAppointment,
        appointment,
        paperworkPages,
        location,
      );
      return {
        statusCode: 200,
        body: JSON.stringify(response),
      };
    }

    console.log('getting user');
    const user = await getUser(authorization.replace('Bearer ', ''));

    // If it's a returning patient, check if the user has
    // access to the patient and the appointment.
    // If the user does not have access to either,
    // do not return paperwork information.
    // todo: this endpoint currently takes patient ID
    // and appointment ID, but it might not need to take
    // one of them, so we need to update the check here.
    console.log('checking user access to patient');
    const userAccess = await userHasAccessToPatient(user, appointmentPatient, fhirClient);
    if (!userAccess) {
      console.log('User is authorized without permission to access this appointment');
      const response = getPaperworkForUserWithoutAccess(
        paperworkComplete,
        paperworkFilledOutForAppointment,
        appointment,
        paperworkPages,
        location,
      );
      return {
        statusCode: 200,
        body: JSON.stringify(response),
      };
    }

    const questionnaireItemsToExclude: string[] = [];
    if (!paperworkFilledOutForAppointment) {
      console.log(
        `Paperwork is not filled out for this appointment, getting a recent questionnaire response for patient ${appointmentPatient}`,
      );
      questionnaireResponseResource = await getRecentQuestionnaireResponse(
        questionnaire.id,
        appointmentPatient,
        fhirClient,
      );
      if (questionnaireResponseResource && questionnaireResponseResource.item) {
        responses = await updateQuestionnaireResponseItems(
          questionnaireResponseResource.item,
          responseItemsNotToPrefill,
        );
      }
    }

    if (questionnaireResponseResource) {
      questionnaireItemsToExclude.push(...['point-of-discovery-additional-text', 'patient-point-of-discovery']);
    }

    paperworkPages = paperworkPages.map((paperworkPage) => ({
      ...paperworkPage,
      questions: paperworkPage.questions.filter((question) => !questionnaireItemsToExclude.includes(question.id)),
    }));

    const partialAppointment = getPaperworkForUserWithoutAccess(
      paperworkComplete,
      paperworkFilledOutForAppointment,
      appointment,
      paperworkPages,
      location,
    );

    console.log(`getting presigned urls for any current document reference files for patient ${appointmentPatient}`);
    // Get DocumentReference codings from Questionnaire
    const docTypes: Set<string> = new Set<string>();
    const fileQuestionIDs: string[] = [];

    paperworkPages.forEach((page: PaperworkPage) => {
      page.questions.forEach((question) => {
        if (question.type === 'File' || question.type === 'Photos') {
          fileQuestionIDs.push(question.id);
          question.docType && docTypes.add(question.docType);
        }
      });
    });

    // Get presigned urls from DocumentReferences
    const presignedURLs = await getPresignedURLsfromDocRefURLs(
      appointmentPatient,
      fileQuestionIDs,
      Array.from(docTypes),
      fhirClient,
    );

    console.log('building get paperwork response');
    const response: PaperworkResponseWithResponses = {
      ...partialAppointment,
      paperwork: responses,
      files: presignedURLs,
    };
    return {
      statusCode: 200,
      body: JSON.stringify(response),
    };
  } catch (error: any) {
    console.log(error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal error' }),
    };
  }
};

function getPaperworkForUserWithoutAccess(
  completedPaperwork: boolean,
  paperworkFilledOutForAppointment: boolean,
  appointment: Appointment | undefined,
  questions: PaperworkPage[],
  location: Location | undefined,
): PaperworkResponseWithoutResponses {
  return {
    message: 'Successfully retrieved appointment date/time and paperwork status for this appointment',
    questions: questions,
    paperworkCompleteOrInProgress: completedPaperwork || paperworkFilledOutForAppointment,
    appointment: {
      start: appointment?.start || 'Unknown',
      location: {
        id: location?.id,
        slug: location?.identifier?.find(
          (identifierTemp) => identifierTemp.system === 'https://fhir.ottehr.com/r4/slug',
        )?.value,
        name: location?.name,
        description: location?.description,
        address: location?.address,
        telecom: location?.telecom,
        hoursOfOperation: location?.hoursOfOperation,
        timezone: location?.extension?.find((extensionTemp) => extensionTemp.url === TIMEZONE_EXTENSION)?.valueString,
        otherOffices: location ? getOtherOfficesForLocation(location) : [],
      },
    },
  };
}

async function updateQuestionnaireResponseItems(
  questionnaireResponseItems: QuestionnaireResponseItem[],
  itemsNotToPrefill: string[],
): Promise<any> {
  const responses: any = {};
  questionnaireResponseItems
    .filter((responseTemp) => !itemsNotToPrefill.includes(responseTemp.linkId))
    .map((responseTemp) => {
      responses[responseTemp.linkId] =
        getCorrectInputOption(responseTemp.linkId, responseTemp.answer?.[0].valueString || '') ||
        responseTemp.answer?.[0].valueDate ||
        responseTemp.answer?.[0].valueBoolean ||
        mapPaperworkResponseItem(responseTemp).answer?.[0].valueArray ||
        '';
    });
  return responses;
}

async function getPresignedURLsfromDocRefURLs(
  patientID: string,
  fileQuestionIDs: string[],
  docTypes: string[],
  fhirClient: FhirClient,
  // z3Client: Z3Client,
  // projectAPI: string
): Promise<FileURLs | undefined> {
  // If questionnaire does not include docTypes return undefined
  if (docTypes.length === 0) {
    return undefined;
  }

  const docRefResources = await fhirClient.searchResources<DocumentReference>({
    resourceType: 'DocumentReference',
    searchParams: [
      {
        name: 'status',
        value: 'current',
      },
      {
        name: 'related',
        value: `Patient/${patientID}`,
      },
      {
        name: 'type',
        value: docTypes.join(','),
      },
      { name: '_sort', value: '-_lastUpdated' },
    ],
  });

  console.log('checking returned document references for photo IDs and insurance cards');

  const presignedUrlObj: FileURLs = {};

  for (const type of docTypes) {
    // Find a DocumentReference that matches the coding
    const docRefTemp = docRefResources.find((docRef) => docRef.type?.coding?.find((coding) => coding.code === type));
    // Get Z3 URLs and presigned URLS for each id
    for (const id of fileQuestionIDs) {
      const docContentEntries = docRefTemp?.content.filter((content) => content.attachment.title?.startsWith(id));
      for (const docContent of docContentEntries || []) {
        const z3Url = docContent?.attachment.url;
        if (z3Url) {
          presignedUrlObj[docContent.attachment.title || id] = {
            z3Url: docContent.attachment.url,
            presignedUrl: await getPresignedURL(z3Url, zapehrToken),
          };
        }
      }
    }
  }

  return presignedUrlObj;
}
