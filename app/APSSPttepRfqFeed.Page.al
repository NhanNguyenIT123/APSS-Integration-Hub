page 70308 "APSS PTTEP RFQ Feed"
{
    PageType = List;
    ApplicationArea = All;
    UsageCategory = Lists;
    SourceTable = "APSS RFQ Buffer";
    SourceTableView = where(Portal = const('PTTEP FlashBuy'));
    Caption = 'PTTEP RFQ Feed';
    InsertAllowed = false;
    ModifyAllowed = false;

    layout
    {
        area(Content)
        {
            repeater(Group)
            {
                field("RFQ No."; Rec."RFQ No.")
                {
                    ApplicationArea = All;
                    ToolTip = 'The unique RFQ number.';
                    
                    trigger OnDrillDown()
                    var
                        SyncCU: Codeunit "APSS Middleware Sync";
                    begin
                        SyncCU.OpenCachedOrFetchRfqPreview(Rec."RFQ No.");
                    end;
                }
                field(Subject; Rec.Subject)
                {
                    ApplicationArea = All;
                    ToolTip = 'The subject description of the RFQ.';
                }
                field(Drafter; Rec.Drafter)
                {
                    ApplicationArea = All;
                    ToolTip = 'The person or entity who created the RFQ.';
                }
                field("Register Date"; Rec."Register Date")
                {
                    ApplicationArea = All;
                    ToolTip = 'The registration date.';
                }
                field("Close Date"; Rec."Close Date")
                {
                    ApplicationArea = All;
                    ToolTip = 'The closing date.';
                }
                field("Item Count"; Rec."Item Count")
                {
                    ApplicationArea = All;
                    ToolTip = 'The number of procurement items.';
                }
                field("Sales Quote Created"; Rec."Sales Quote Created")
                {
                    ApplicationArea = All;
                    ToolTip = 'The draft Sales Quote number created in BC.';
                }
            }
        }
    }

    actions
    {
        area(Processing)
        {
            action(FetchRfqList)
            {
                ApplicationArea = All;
                Caption = 'Refresh RFQ List';
                ToolTip = 'Re-sync the RFQ list from the Middleware database. Use this if the list appears outdated or after uploading a new PTTEP Excel file.';
                Image = Refresh;
                Promoted = true;
                PromotedCategory = Process;
                PromotedIsBig = true;

                trigger OnAction()
                var
                    SyncCU: Codeunit "APSS Middleware Sync";
                begin
                    SyncCU.FetchRfqList();
                    if not Rec.Get(Rec."RFQ No.") then
                        if Rec.FindFirst() then;
                    CurrPage.Update(false);
                    Message('RFQ list refreshed successfully from Middleware.');
                end;
            }

            action(PullAndDraft)
            {
                ApplicationArea = All;
                Caption = 'Pull & Draft Sales Quote';
                ToolTip = 'Pull line items from Middleware for the selected RFQ, check/create Item cards, and draft a Sales Quote.';
                Image = CreateDocument;
                Promoted = true;
                PromotedCategory = Process;
                PromotedIsBig = true;
                Enabled = Rec."RFQ No." <> '';

                trigger OnAction()
                var
                    SyncCU: Codeunit "APSS Middleware Sync";
                begin
                    SyncCU.OpenCachedOrFetchRfqPreview(Rec."RFQ No.");
                    CurrPage.Update(false);
                end;
            }



            action(UploadPttepExcel)
            {
                ApplicationArea = All;
                Caption = 'Upload PTTEP Excel Feed';
                ToolTip = 'Select a PTTEP FlashBuy catalog Excel sheet and upload it to Middleware.';
                Image = ImportExcel;
                Promoted = true;
                PromotedCategory = Process;
                PromotedIsBig = true;

                trigger OnAction()
                var
                    SyncCU: Codeunit "APSS Middleware Sync";
                    InStream: InStream;
                    FileName: Text;
                begin
                    if UploadIntoStream('Upload PTTEP Excel File', '', 'Excel Files (*.xlsx)|*.xlsx', FileName, InStream) then begin
                        SyncCU.UploadPttepExcel(FileName, InStream);
                        CurrPage.Update(false);
                    end;
                end;
            }

            action(CancelPttepImport)
            {
                ApplicationArea = All;
                Caption = 'Cancel PTTEP Import';
                ToolTip = 'Abort active PTTEP Excel ingestion pipeline on the Middleware.';
                Image = Cancel;
                Promoted = true;
                PromotedCategory = Process;

                trigger OnAction()
                var
                    SyncCU: Codeunit "APSS Middleware Sync";
                begin
                    SyncCU.CancelPttepImport();
                end;
            }

            action(CheckPttepImportStatus)
            {
                ApplicationArea = All;
                Caption = 'Check Import Status';
                ToolTip = 'Check the current progress of the PTTEP Excel ingestion pipeline. If completed, the RFQ list will be refreshed automatically.';
                Image = Track;
                Promoted = true;
                PromotedCategory = Process;
                PromotedIsBig = true;

                trigger OnAction()
                var
                    SyncCU: Codeunit "APSS Middleware Sync";
                begin
                    SyncCU.CheckPttepImportStatus();
                    CurrPage.Update(false);
                end;
            }

            action(OpenPttepBrandFeed)
            {
                ApplicationArea = All;
                Caption = 'PTTEP Brand Feed';
                ToolTip = 'Open the PTTEP Brand Feed analysis page.';
                Image = ShowList;
                RunObject = Page "APSS PTTEP Brand Feed";
                Promoted = true;
                PromotedCategory = Process;
                PromotedIsBig = true;
            }

            action(OpenSetup)
            {
                ApplicationArea = All;
                Caption = 'Integration Setup';
                ToolTip = 'Open the APSS Integration Setup card.';
                Image = Setup;
                RunObject = Page "APSS Integration Setup";
                Promoted = true;
                PromotedCategory = Process;
            }
        }
    }
}
