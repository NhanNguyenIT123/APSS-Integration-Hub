page 70302 "APSS RFQ Feed"
{
    PageType = List;
    ApplicationArea = All;
    UsageCategory = Lists;
    SourceTable = "APSS RFQ Buffer";
    Caption = 'APSS RFQ Feed';
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
                field(Portal; Rec.Portal)
                {
                    ApplicationArea = All;
                    ToolTip = 'The originating procurement portal (POSCO, PTTEP, etc.)';
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
                Caption = 'Fetch Active RFQs';
                ToolTip = 'Retrieve the list of active RFQs from the Integration Middleware.';
                Image = Refresh;
                Promoted = true;
                PromotedCategory = Process;
                PromotedIsBig = true;

                trigger OnAction()
                var
                    SyncCU: Codeunit "APSS Middleware Sync";
                begin
                    SyncCU.FetchRfqList();
                    CurrPage.Update(false);
                    Message('Active RFQs successfully fetched from Middleware.');
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

            action(PullAllAndDraft)
            {
                ApplicationArea = All;
                Caption = 'Pull & Draft All RFQs';
                ToolTip = 'Pull line items and draft Sales Quotes for all active RFQs in the feed that have not been processed yet.';
                Image = Copy;
                Promoted = true;
                PromotedCategory = Process;
                PromotedIsBig = true;

                trigger OnAction()
                var
                    RfqBuffer: Record "APSS RFQ Buffer";
                    Opportunity: Record Opportunity;
                    SalesHeader: Record "Sales Header";
                    SuccessCount: Integer;
                    FailCount: Integer;
                    LastError: Text;
                begin
                    SuccessCount := 0;
                    FailCount := 0;
                    RfqBuffer.Reset();
                    RfqBuffer.SetRange("Sales Quote Created", '');
                    if RfqBuffer.FindSet() then begin
                        repeat
                            // Check if Sales Quote already exists in database to avoid calling Codeunit.Run
                            SalesHeader.Reset();
                            SalesHeader.SetRange("Document Type", SalesHeader."Document Type"::Quote);
                            SalesHeader.SetRange("External Document No.", RfqBuffer."RFQ No.");
                            if SalesHeader.FindFirst() then begin
                                RfqBuffer."Sales Quote Created" := SalesHeader."No.";
                                RfqBuffer.Modify();
                                Commit();
                            end else begin
                                Commit(); // Commit current transaction before running Codeunit.Run to prevent open transaction errors
                                if Codeunit.Run(Codeunit::"APSS Middleware Sync", RfqBuffer) then begin
                                    SuccessCount += 1;
                                end else begin
                                    FailCount += 1;
                                    LastError := GetLastErrorText();
                                end;
                            end;
                        until RfqBuffer.Next() = 0;

                        if FailCount > 0 then
                            Message('%1 RFQs processed successfully. %2 RFQs failed to pull. Last error: %3', SuccessCount, FailCount, LastError);
                    end;
                    CurrPage.Update(false);
                end;
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
